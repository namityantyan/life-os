// Pure logic for the health module (no D1 / network) so it is unit-testable.

/* ---------- Nutrition ---------- */
export const NUTRIENT_KEYS = [
  "energy_kcal", "protein_g", "fat_g", "carbs_g", "fiber_g", "salt_g",
  "calcium_mg", "iron_mg", "magnesium_mg", "zinc_mg", "potassium_mg",
  "vitamin_a_ug", "vitamin_b1_mg", "vitamin_b2_mg", "vitamin_b6_mg", "vitamin_b12_ug", "vitamin_c_mg", "vitamin_d_ug", "vitamin_e_mg", "folate_ug",
] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  energy_kcal: "エネルギー", protein_g: "たんぱく質", fat_g: "脂質", carbs_g: "炭水化物", fiber_g: "食物繊維", salt_g: "食塩相当量",
  calcium_mg: "カルシウム", iron_mg: "鉄", magnesium_mg: "マグネシウム", zinc_mg: "亜鉛", potassium_mg: "カリウム",
  vitamin_a_ug: "ビタミンA", vitamin_b1_mg: "ビタミンB1", vitamin_b2_mg: "ビタミンB2", vitamin_b6_mg: "ビタミンB6", vitamin_b12_ug: "ビタミンB12",
  vitamin_c_mg: "ビタミンC", vitamin_d_ug: "ビタミンD", vitamin_e_mg: "ビタミンE", folate_ug: "葉酸",
};
export const NUTRIENT_UNITS: Record<NutrientKey, string> = Object.fromEntries(
  NUTRIENT_KEYS.map((k) => [k, k.endsWith("_kcal") ? "kcal" : k.endsWith("_ug") ? "µg" : k.endsWith("_mg") ? "mg" : "g"]),
) as Record<NutrientKey, string>;

export type Nutrition = Partial<Record<NutrientKey, number>>;

export type NutritionSummary = {
  totals: Record<NutrientKey, number | null>; // null = no item provided this nutrient
  partial: boolean;         // any item without nutrition → totals are incomplete
  item_count: number;
  with_nutrition: number;
  estimated_count: number;
  /** nutrients for which at least one nutrition-carrying item lacked a value (per-nutrient partial) */
  partial_keys: NutrientKey[];
};

/** Parses a nutrition_json string; returns null if invalid/empty. */
export function parseNutrition(json: string | null | undefined): Nutrition | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return null;
    const out: Nutrition = {};
    for (const k of NUTRIENT_KEYS) { const v = raw[k]; if (typeof v === "number" && Number.isFinite(v)) out[k] = v; }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/**
 * Totals nutrition across a routine. Any item that has no nutrition at all makes the whole
 * summary `partial` (the routine is "a plan" and we must not claim完全な合計).
 */
export function summarizeNutrition(items: { nutrition_json: string | null; nutrition_source?: string | null }[]): NutritionSummary {
  const totals = Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, null])) as Record<NutrientKey, number | null>;
  let partial = false, withNutrition = 0, estimated = 0;
  const parsed: Nutrition[] = [];
  for (const it of items) {
    const n = parseNutrition(it.nutrition_json);
    if (!n) { partial = true; continue; }
    withNutrition++;
    if (it.nutrition_source === "estimated") estimated++;
    parsed.push(n);
    for (const k of NUTRIENT_KEYS) if (n[k] != null) totals[k] = (totals[k] ?? 0) + (n[k] as number);
  }
  const partialKeys = NUTRIENT_KEYS.filter((k) => totals[k] != null && parsed.some((n) => n[k] == null));
  return { totals, partial: partial || items.length === 0, item_count: items.length, with_nutrition: withNutrition, estimated_count: estimated, partial_keys: partialKeys };
}

/* ---------- Cost ---------- */
export type CostEstimate = { total: number | null; counted: number; missing: number };
/** Sums cost_per_serving; unset costs are *not* treated as 0 — they are reported as missing. */
export function estimateCost(items: { cost_per_serving: number | null | undefined }[]): CostEstimate {
  let total: number | null = null, counted = 0, missing = 0;
  for (const it of items) {
    const c = it.cost_per_serving;
    if (c == null || !Number.isFinite(c)) { missing++; continue; }
    total = (total ?? 0) + c; counted++;
  }
  return { total, counted, missing };
}

/* ---------- Pressure: personal threshold ---------- */
export const PERSONAL_MIN_LOGS = 5;
export type PersonalThreshold =
  | { ready: false; count: number; reason: "insufficient" | "no_baseline" | "unclear"; symptom_mean?: number; baseline_mean?: number }
  | { ready: true; count: number; symptom_mean: number; baseline_mean: number; threshold: number; ratio: number };

/**
 * Builds a personal threshold only when at least PERSONAL_MIN_LOGS valid logs exist.
 * valid = log with delta3h recorded. Compares mean |delta3h| at symptom times to the
 * baseline mean |delta3h| (hourly series). The relation must be clearly larger (×1.25)
 * to be "ready"; otherwise we report it as unclear — never a completed personal baseline.
 */
export function computePersonalThreshold(
  logs: { delta3h: number | null; deleted_at?: string | null }[],
  baselineAbsDeltas: number[],
): PersonalThreshold {
  const valid = logs.filter((l) => !l.deleted_at && l.delta3h != null && Number.isFinite(l.delta3h));
  const count = valid.length;
  if (count < PERSONAL_MIN_LOGS) return { ready: false, count, reason: "insufficient" };
  const base = baselineAbsDeltas.filter((v) => Number.isFinite(v));
  if (base.length < 12) return { ready: false, count, reason: "no_baseline" };
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const symptomMean = mean(valid.map((l) => Math.abs(l.delta3h as number)));
  const baselineMean = mean(base);
  const ratio = baselineMean > 0 ? symptomMean / baselineMean : symptomMean > 0 ? Infinity : 1;
  if (!(ratio >= 1.25)) return { ready: false, count, reason: "unclear", symptom_mean: symptomMean, baseline_mean: baselineMean };
  // Threshold: midpoint between baseline and symptom means, never below 1 hPa.
  const threshold = Math.max(1, (symptomMean + baselineMean) / 2);
  return { ready: true, count, symptom_mean: symptomMean, baseline_mean: baselineMean, threshold, ratio };
}

/* ---------- Oura normalization ---------- */
export type OuraDailyRow = {
  day: string;
  sleep_duration_sec: number | null; sleep_score: number | null; readiness_score: number | null;
  steps: number | null; hrv: number | null; resting_hr: number | null; sleep_balance: number | null;
};
type OuraDailySleep = { day: string; score?: number | null };
type OuraDailyReadiness = { day: string; score?: number | null; contributors?: { sleep_balance?: number | null } | null };
type OuraDailyActivity = { day: string; steps?: number | null };
type OuraSleep = { day: string; type?: string; total_sleep_duration?: number | null; average_hrv?: number | null; lowest_heart_rate?: number | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Merges the 4 Oura v2 collections into one row per day. Missing values stay null. */
export function normalizeOura(input: { daily_sleep?: OuraDailySleep[]; daily_readiness?: OuraDailyReadiness[]; daily_activity?: OuraDailyActivity[]; sleep?: OuraSleep[] }): OuraDailyRow[] {
  const rows = new Map<string, OuraDailyRow>();
  const get = (day: string) => {
    let r = rows.get(day);
    if (!r) { r = { day, sleep_duration_sec: null, sleep_score: null, readiness_score: null, steps: null, hrv: null, resting_hr: null, sleep_balance: null }; rows.set(day, r); }
    return r;
  };
  for (const s of input.daily_sleep ?? []) if (s?.day) get(s.day).sleep_score = num(s.score);
  for (const r of input.daily_readiness ?? []) if (r?.day) { const row = get(r.day); row.readiness_score = num(r.score); row.sleep_balance = num(r.contributors?.sleep_balance); }
  for (const a of input.daily_activity ?? []) if (a?.day) get(a.day).steps = num(a.steps);
  // Sleep sessions: prefer the "long_sleep" session; otherwise the longest one of the day.
  const byDay = new Map<string, OuraSleep[]>();
  for (const s of input.sleep ?? []) if (s?.day) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  for (const [day, list] of byDay) {
    const pick = list.find((s) => s.type === "long_sleep") ?? [...list].sort((a, b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0];
    const row = get(day);
    row.sleep_duration_sec = num(pick.total_sleep_duration);
    row.hrv = num(pick.average_hrv);
    row.resting_hr = num(pick.lowest_heart_rate);
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** "7時間12分" style formatter (shared by UI & tests). */
export function formatSleepDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}時間${String(m).padStart(2, "0")}分`;
}

/* ---------- Meal chat proposals (routine add / update / remove, targets) ---------- */
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];
const SLOT_ALIASES: Record<string, MealSlot> = {
  breakfast: "breakfast", 朝: "breakfast", 朝食: "breakfast", 朝ごはん: "breakfast", あさ: "breakfast",
  lunch: "lunch", 昼: "lunch", 昼食: "lunch", 昼ごはん: "lunch", ランチ: "lunch",
  dinner: "dinner", 夜: "dinner", 夕: "dinner", 夕食: "dinner", 晩: "dinner", 晩ごはん: "dinner", 夜ごはん: "dinner", ディナー: "dinner",
  snack: "snack", 間食: "snack", おやつ: "snack", 補食: "snack", スナック: "snack",
};
export function normalizeSlot(v: unknown): MealSlot | null {
  if (typeof v !== "string") return null;
  return SLOT_ALIASES[v.trim().toLowerCase()] ?? SLOT_ALIASES[v.trim()] ?? null;
}

export type MealFields = { slot?: MealSlot; food_name?: string; amount?: number | null; unit?: string | null; cost_per_serving?: number | null; nutrition?: Nutrition | null };
export type MealOp =
  | { op: "add"; slot: MealSlot; food_name: string; amount: number | null; unit: string | null; cost_per_serving: number | null; nutrition: Nutrition | null }
  | { op: "update"; id: string; food_name: string; changes: MealFields }
  | { op: "remove"; id: string; food_name: string };
export type ExistingMeal = { id: string; slot: string; food_name: string; amount?: number | null; nutrition?: Nutrition | null };
export type MealProposal = { targets: Nutrition | null; routines: MealOp[] };

const mealNum = (v: unknown, { min = 0, max = 1e6 } = {}): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,，円gｇ]/g, ""));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : undefined;
};
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const sameName = (a: string, b: string) => a.normalize("NFKC").replace(/\s/g, "").toLowerCase() === b.normalize("NFKC").replace(/\s/g, "").toLowerCase();

/** Resolve an update/remove target: by id, else by unique food name (and slot when given). */
function resolveExisting(raw: Record<string, unknown>, existing: ExistingMeal[]): ExistingMeal | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (id) return existing.find((m) => m.id === id) ?? null;
  const name = text(raw.target_food_name ?? raw.food_name_before ?? raw.food_name, 120);
  if (!name) return null;
  const slot = normalizeSlot(raw.target_slot ?? raw.slot);
  const hits = existing.filter((m) => sameName(m.food_name, name) && (!slot || m.slot === slot));
  return hits.length === 1 ? hits[0]! : null; // ambiguous or unknown → drop
}

/**
 * Validates an AI proposal against the current routine. Invalid, unresolvable or no-op items are dropped,
 * so the UI only ever offers changes that can be applied safely. At most 12 routine operations.
 */
export function normalizeMealProposal(raw: unknown, existing: ExistingMeal[]): MealProposal {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const targets = r.targets && typeof r.targets === "object" ? parseNutrition(JSON.stringify(r.targets)) : null;
  const ops: MealOp[] = [];
  const touched = new Set<string>();
  for (const it of Array.isArray(r.routines) ? r.routines.slice(0, 20) : []) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const kind = String(o.op ?? o.action ?? "").toLowerCase();
    if (kind === "add" || kind === "追加") {
      const slot = normalizeSlot(o.slot); const food = text(o.food_name, 120);
      if (!slot || !food) continue;
      if (ops.some((x) => x.op === "add" && x.slot === slot && sameName(x.food_name, food))) continue;
      const amount = mealNum(o.amount, { min: 0.01, max: 100000 }); const cost = mealNum(o.cost_per_serving ?? o.cost, { min: 0, max: 1e6 });
      ops.push({ op: "add", slot, food_name: food, amount: amount ?? null, unit: text(o.unit, 20), cost_per_serving: cost ?? null, nutrition: o.nutrition ? parseNutrition(JSON.stringify(o.nutrition)) : null });
    } else if (kind === "update" || kind === "change" || kind === "変更") {
      const cur = resolveExisting(o, existing); if (!cur || touched.has(cur.id)) continue;
      const src = (o.changes && typeof o.changes === "object" ? o.changes : o) as Record<string, unknown>;
      const changes: MealFields = {};
      const slot = src.new_slot !== undefined ? normalizeSlot(src.new_slot) : src.slot !== undefined && o.changes ? normalizeSlot(src.slot) : null;
      if (slot && slot !== cur.slot) changes.slot = slot;
      const newName = text(src.new_food_name ?? (o.changes ? src.food_name : undefined), 120);
      if (newName && !sameName(newName, cur.food_name)) changes.food_name = newName;
      const amount = mealNum(src.amount, { min: 0.01, max: 100000 }); if (amount !== undefined && amount !== (cur.amount ?? null)) changes.amount = amount;
      if (src.unit !== undefined) { const u = text(src.unit, 20); if (u !== null) changes.unit = u; }
      const cost = mealNum(src.cost_per_serving ?? src.cost, { min: 0, max: 1e6 }); if (cost !== undefined) changes.cost_per_serving = cost;
      if (src.nutrition && typeof src.nutrition === "object") { const n = parseNutrition(JSON.stringify(src.nutrition)); if (n) changes.nutrition = n; }
      if (!Object.keys(changes).length) continue;
      touched.add(cur.id); ops.push({ op: "update", id: cur.id, food_name: cur.food_name, changes });
    } else if (kind === "remove" || kind === "delete" || kind === "削除") {
      const cur = resolveExisting(o, existing); if (!cur || touched.has(cur.id)) continue;
      touched.add(cur.id); ops.push({ op: "remove", id: cur.id, food_name: cur.food_name });
    }
    if (ops.length >= 12) break;
  }
  return { targets: targets && Object.keys(targets).length ? targets : null, routines: ops };
}

/** When only the amount changes, scale the stored per-serving nutrition by the ratio (result is an estimate). */
export function scaleNutrition(n: Nutrition | null | undefined, from: number | null | undefined, to: number | null | undefined): Nutrition | null {
  if (!n || !from || !to || from <= 0 || to <= 0) return null;
  const k = to / from; const out: Nutrition = {};
  for (const [key, v] of Object.entries(n)) if (typeof v === "number") out[key as NutrientKey] = Math.round(v * k * 10) / 10;
  return out;
}
