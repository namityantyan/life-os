// Pure training logic (no D1). Unit-tested in tests/unit/training.test.ts.
import type { CatalogEntry, WeightUnit } from "../../../shared/training";

export type SetLike = {
  id?: string;
  weight: number | null;
  reps: number | null;
  duration_sec?: number | null;
  unit: WeightUnit | string | null;
  created_at: string;
};

export type OneRm = { value: number; reference: boolean };

export type SetInput = { weight?: number | null; reps?: number | null; duration_sec?: number | null; memo?: string | null };
export type NormalizedSet = { unit: WeightUnit; weight: number | null; reps: number | null; duration_sec: number | null };

/**
 * Normalizes a set for storage. The recording unit always comes from the catalog entry
 * (dumbbell → per_hand, smith → plate, bodyweight → reps only, plank → seconds); a client-supplied
 * unit is never trusted, so a weighted exercise cannot be stored as "bodyweight" (dropping its weight)
 * and a bodyweight exercise cannot gain a weight-based 1RM. Throws on missing reps / seconds.
 */
export function normalizeSetInput(entry: CatalogEntry, body: SetInput): NormalizedSet {
  const unit: WeightUnit = entry.measurement === "seconds" ? "time" : entry.unit;
  const isTime = unit === "time", isBw = unit === "bodyweight";
  const weight = isTime || isBw ? null : body.weight ?? null;
  const reps = isTime ? null : body.reps ?? null;
  const duration_sec = isTime ? body.duration_sec ?? null : null;
  if (isTime && duration_sec == null) throw new Error("duration_sec required");
  if (!isTime && reps == null) throw new Error("reps required");
  if (!isTime && !isBw && (weight == null || !(weight > 0))) throw new Error("weight required");
  return { unit, weight, reps, duration_sec };
}

/** Japanese reply for a normalizeSetInput error (used by the Discord natural-text path). */
export function setInputMessage(err: string, exerciseName: string): string {
  if (err.startsWith("weight")) return `${exerciseName}は重量が必要です。例：「${exerciseName} 60kg 8回」`;
  if (err.startsWith("duration")) return `${exerciseName}は秒数で記録します。例：「${exerciseName} 60秒」`;
  if (err.startsWith("reps")) return `${exerciseName}は回数が必要です。例：「${exerciseName} 10回」`;
  return "読み取れませんでした。";
}

const WEIGHT_UNITS = new Set<string>(["total", "per_hand", "plate"]);
const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Epley estimated 1RM: weight × (1 + reps / 30).
 * - reps = 1 → the weight itself.
 * - valid reps are 1..30 (integer); anything else → null.
 * - reps ≥ 11 are flagged `reference: true` (参考値) because the formula drifts at high reps.
 * - non-finite or non-positive weights → null.
 */
export function estimate1RM(weight: number | null | undefined, reps: number | null | undefined): OneRm | null {
  if (!isFiniteNum(weight) || weight <= 0) return null;
  if (!isFiniteNum(reps) || !Number.isInteger(reps) || reps < 1 || reps > 30) return null;
  if (reps === 1) return { value: weight, reference: false };
  const value = Math.round(weight * (1 + reps / 30) * 10) / 10;
  return { value, reference: reps >= 11 };
}

/** True when a set's unit allows a weight-based 1RM. Unknown / bodyweight / time units do not. */
export function hasWeightUnit(unit: string | null | undefined): boolean {
  return Boolean(unit && WEIGHT_UNITS.has(unit));
}

/**
 * Pick the best set across ALL given sets (never only the first set of a session).
 * - Weight units (total / per_hand / plate): max weight; tie → more reps; tie → newer.
 * - bodyweight: most reps; tie → newer.  time: longest duration; tie → newer.
 * Sets are compared by created_at (ISO string) for recency.
 */
export function pickBest<T extends SetLike>(sets: readonly T[]): { best: T | null; est_1rm: OneRm | null } {
  const weighted = sets.filter((s) => hasWeightUnit(s.unit) && isFiniteNum(s.weight) && (s.weight as number) > 0);
  if (weighted.length) {
    const best = weighted.reduce((a, b) => (compareWeighted(b, a) > 0 ? b : a));
    return { best, est_1rm: estimate1RM(best.weight, best.reps) };
  }
  const timed = sets.filter((s) => s.unit === "time" && isFiniteNum(s.duration_sec) && (s.duration_sec as number) > 0);
  if (timed.length) {
    const best = timed.reduce((a, b) => ((b.duration_sec ?? 0) > (a.duration_sec ?? 0) || ((b.duration_sec ?? 0) === (a.duration_sec ?? 0) && b.created_at > a.created_at) ? b : a));
    return { best, est_1rm: null };
  }
  const bw = sets.filter((s) => s.unit === "bodyweight" && isFiniteNum(s.reps) && (s.reps as number) > 0);
  if (bw.length) {
    const best = bw.reduce((a, b) => ((b.reps ?? 0) > (a.reps ?? 0) || ((b.reps ?? 0) === (a.reps ?? 0) && b.created_at > a.created_at) ? b : a));
    return { best, est_1rm: null };
  }
  return { best: null, est_1rm: null };
}

function compareWeighted(a: SetLike, b: SetLike): number {
  const w = (a.weight ?? 0) - (b.weight ?? 0);
  if (w !== 0) return w;
  const r = (a.reps ?? 0) - (b.reps ?? 0);
  if (r !== 0) return r;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

export type Advice = {
  kind: "start" | "add_reps" | "add_weight" | "hold" | "bodyweight" | "time";
  weight: number | null;
  target_reps: number | null;
  target_sec?: number | null;
  message: string;
};

/**
 * "Increase reps until rep_max, then add the catalog increment" progression.
 * `history` is the exercise's sets, newest first. Only the most recent session is used as the baseline.
 */
export function progressionAdvice(history: readonly (SetLike & { session_id?: string })[], entry: CatalogEntry): Advice {
  const unit: WeightUnit = entry.measurement === "seconds" ? "time" : entry.unit;
  const { rep_min, rep_max, increment, name } = entry;
  if (history.length === 0) {
    if (unit === "time") return { kind: "start", weight: null, target_reps: null, target_sec: 30, message: `${name}はまだ記録がありません。まず30秒を目安に始めましょう。` };
    if (unit === "bodyweight") return { kind: "start", weight: null, target_reps: rep_min, message: `${name}はまだ記録がありません。まず${rep_min}回を目安に始めましょう。` };
    return { kind: "start", weight: null, target_reps: rep_min, message: `${name}はまだ記録がありません。フォームが崩れず${rep_min}回できる重量から始めましょう。` };
  }
  const lastSession = history[0].session_id;
  const recent = lastSession ? history.filter((s) => s.session_id === lastSession) : [history[0]];

  if (unit === "time") {
    const best = Math.max(...recent.map((s) => s.duration_sec ?? 0));
    const target = best + 10;
    return { kind: "time", weight: null, target_reps: null, target_sec: target, message: `前回は最長${best}秒。次は${target}秒を目指しましょう。` };
  }
  if (unit === "bodyweight") {
    const best = Math.max(...recent.map((s) => s.reps ?? 0));
    return { kind: "bodyweight", weight: null, target_reps: best + 1, message: `前回は最多${best}回。次は${best + 1}回を目指しましょう。` };
  }
  const weighted = recent.filter((s) => isFiniteNum(s.weight) && (s.weight as number) > 0);
  if (!weighted.length) return { kind: "hold", weight: null, target_reps: rep_min, message: `前回の重量が記録されていません。${rep_min}〜${rep_max}回でできる重量で記録しましょう。` };
  const top = Math.max(...weighted.map((s) => s.weight as number));
  const topSets = weighted.filter((s) => s.weight === top);
  const minReps = Math.min(...topSets.map((s) => s.reps ?? 0));
  if (minReps >= rep_max) {
    const next = Math.round((top + increment) * 100) / 100;
    return { kind: "add_weight", weight: next, target_reps: rep_min, message: `前回 ${top}kg で全セット${rep_max}回に到達。次は ${next}kg（+${increment}kg）で ${rep_min}回から。` };
  }
  const targetReps = Math.min(rep_max, Math.max(rep_min, minReps + 1));
  return { kind: "add_reps", weight: top, target_reps: targetReps, message: `前回 ${top}kg × ${minReps}回。重量は据え置きで ${targetReps}回を目指し、${rep_max}回できたら +${increment}kg。` };
}

/** Session summary line for notifications / Discord. */
export function summarizeSession(sets: readonly (SetLike & { exercise_key: string })[], names: (key: string) => string, durationMin: number | null): string {
  const byEx = new Map<string, (SetLike & { exercise_key: string })[]>();
  for (const s of sets) { const arr = byEx.get(s.exercise_key) ?? []; arr.push(s); byEx.set(s.exercise_key, arr); }
  const parts: string[] = [];
  for (const [key, arr] of byEx) {
    const { best } = pickBest(arr);
    let desc = `${arr.length}セット`;
    if (best) {
      if (hasWeightUnit(best.unit)) desc = `${best.weight}kg×${best.reps ?? "—"} / ${arr.length}セット`;
      else if (best.unit === "time") desc = `${best.duration_sec}秒 / ${arr.length}セット`;
      else desc = `${best.reps}回 / ${arr.length}セット`;
    }
    parts.push(`${names(key)} ${desc}`);
  }
  const head = [durationMin != null ? `${durationMin}分` : null, `${sets.length}セット`].filter(Boolean).join("・");
  return [head, ...parts].join("\n");
}
