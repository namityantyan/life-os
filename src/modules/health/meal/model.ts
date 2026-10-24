/** Types (mirror of worker/modules/health/meals.ts) and pure helpers for the meal tab. */
import { fmtNum, todayJst } from "@/lib/api";
import { ALL_NUTRIENTS, numOrNull, fromShown, type Nutrition } from "../shared";

export type TableRef = { number: string; name: string; grams: number; grams_estimated?: boolean };
export type Candidate = { number: string; name: string; per100g: Nutrition };
export type Source = "recorded" | "estimated" | "table" | null;
export type Food = { id: string; name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: Source; nutrition_ref: TableRef | null; cost_per_serving: number | null; use_count: number };
export type SetItem = { id: string; set_id: string; food_name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: Source; nutrition_ref: TableRef | null; cost_per_serving: number | null };
export type MealSet = { id: string; name: string; items: SetItem[]; nutrition: { totals: Record<string, number | null>; partial: boolean }; cost: { total: number | null; missing: number } };
export type Entry = { id: string; day: string; food_name: string; amount: number | null; unit: string | null; nutrition: Nutrition | null; nutrition_source: Source; nutrition_ref: TableRef | null; cost: number | null; servings: number; food_id: string | null; set_id: string | null; sort_order: number };
export type Summary = { nutrition: { totals: Record<string, number | null>; partial: boolean; item_count: number; with_nutrition: number; estimated_count: number; partial_keys: string[] }; cost: { total: number | null; counted: number; missing: number }; targets: Nutrition };
export type DayRes = { day: string; entries: Entry[]; summary: Summary; foods: Food[]; sets: MealSet[] };
export type DayTotal = { day: string; count: number; nutrition: { totals: Record<string, number | null>; partial: boolean } };
export type LookupRes = { applied: boolean; reason?: string; note?: string; candidates?: Candidate[]; match?: TableRef & { nutrition: Nutrition }; item?: Entry };

export const isTemp = (id: string) => id.startsWith("tmp-");
export const tempId = () => `tmp-${Math.random().toString(36).slice(2, 10)}`;

/* ---------------------------------------------------------------- days */
export const shiftDay = (day: string, delta: number) => new Date(Date.parse(day + "T00:00:00Z") + delta * 86400e3).toISOString().slice(0, 10);
const WD = ["日", "月", "火", "水", "木", "金", "土"];
export const weekday = (day: string) => WD[new Date(day + "T00:00:00Z").getUTCDay()]!;
export const mdLabel = (day: string) => { const d = new Date(day + "T00:00:00Z"); return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${weekday(day)}）`; };
export const dayName = (day: string) => { const t = todayJst(); return day === t ? "今日" : day === shiftDay(t, -1) ? "昨日" : day === shiftDay(t, -2) ? "おととい" : null; };

/* ---------------------------------------------------------------- nutrition */
export const scale = (n: Nutrition | null | undefined, k: number): Nutrition | null => {
  if (!n) return null;
  const out: Nutrition = {};
  for (const [key, v] of Object.entries(n)) out[key] = key === "energy_kcal" ? Math.round(v * k) : Math.round(v * k * 100) / 100;
  return out;
};
/** per-100 g table values → grams (unknown keys stay absent, never 0). Same rounding as the server. */
export const forGrams = (per100g: Nutrition, grams: number) => scale(per100g, grams / 100)!;
/** Stored entry values are per serving × servings. */
export const perServing = (e: { nutrition: Nutrition | null; servings?: number }) => scale(e.nutrition, 1 / (e.servings && e.servings > 0 ? e.servings : 1));

/** Same totals the server computes (summarizeNutrition), so optimistic changes show at once. */
export function summarize(entries: { nutrition: Nutrition | null; nutrition_source: Source; cost: number | null }[]) {
  const totals: Record<string, number | null> = Object.fromEntries(ALL_NUTRIENTS.map((n) => [n.key, null]));
  let with_nutrition = 0, estimated_count = 0, costTotal: number | null = null, missing = 0;
  const parsed: Nutrition[] = [];
  for (const e of entries) {
    if (e.cost == null) missing++; else costTotal = (costTotal ?? 0) + e.cost;
    if (!e.nutrition || !Object.keys(e.nutrition).length) continue;
    with_nutrition++; if (e.nutrition_source === "estimated") estimated_count++;
    parsed.push(e.nutrition);
    for (const n of ALL_NUTRIENTS) { const v = e.nutrition[n.key]; if (typeof v === "number") totals[n.key] = (totals[n.key] ?? 0) + v; }
  }
  const partial_keys = ALL_NUTRIENTS.map((n) => n.key).filter((k) => totals[k] != null && parsed.some((n) => n[k] == null));
  return {
    nutrition: { totals, partial: entries.length === 0 || with_nutrition < entries.length, item_count: entries.length, with_nutrition, estimated_count, partial_keys },
    cost: { total: costTotal, counted: entries.length - missing, missing },
  };
}

/** Energy from typed P/F/C (same rule as the server's withPfcEnergy). */
export const pfcEnergy = (n: Record<string, string>, requireAll = false) => {
  const v = ["protein_g", "fat_g", "carbs_g"].map((k) => numOrNull(n[k] ?? ""));
  if (requireAll ? v.some((x) => x == null) : v.every((x) => x == null)) return null;
  const [p, f, c] = v.map((x) => x ?? 0);
  return Math.round(p! * 4 + f! * 9 + c! * 4);
};
/** Typed fields (display units) → stored units, with the energy rule applied. */
export const collectNutrition = (n: Record<string, string>, requireAll = false): Nutrition => {
  const out: Nutrition = {};
  for (const [k, v] of Object.entries(n)) { const x = numOrNull(v); if (x != null && x >= 0) out[k] = fromShown(k, x); }
  const full = pfcEnergy(n, true), some = requireAll ? null : pfcEnergy(n);
  if (full != null) out.energy_kcal = full; else if (out.energy_kcal == null && some != null) out.energy_kcal = some;
  return out;
};

export const SOURCE: Record<string, { label: string; tone: "purple" | "green" | "accent" }> = {
  table: { label: "成分表", tone: "purple" }, recorded: { label: "記録", tone: "green" }, estimated: { label: "推定", tone: "accent" },
};
export const TABLE_CREDIT = "栄養値の出典: 文部科学省「日本食品標準成分表（八訂）増補2023年」（可食部100gあたりの値から量に合わせて計算）";

/** Macro colours (design tokens, so they follow every design and mode). */
export const MACROS = [
  { key: "protein_g", label: "たんぱく質", short: "P", color: "var(--teal)" },
  { key: "fat_g", label: "脂質", short: "F", color: "var(--orange)" },
  { key: "carbs_g", label: "炭水化物", short: "C", color: "var(--indigo)" },
] as const;

/** "2個" / "1.5本" / "150g" (no trailing .0). */
export const amountText = (a: number | null | undefined, u: string | null | undefined) => (a == null ? "" : `${fmtNum(a, a % 1 ? 1 : 0)}${u ?? ""}`);
