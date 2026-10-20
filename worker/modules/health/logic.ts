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
