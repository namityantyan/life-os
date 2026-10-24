// Movement targets and advice (pure; no D1 / network) so they are unit-testable.
//
// Standards (primary sources):
// - 厚生労働省「健康づくりのための身体活動・運動ガイド2023」推奨事項一覧（成人）:
//   歩行又はそれと同等以上（3メッツ以上）の身体活動を1日60分以上（1日約8,000歩以上, 週23メッツ・時以上）,
//   息が弾み汗をかく程度以上の運動を週60分以上（週4メッツ・時以上）, 筋力トレーニングを週2〜3日,
//   座りっぱなしの時間が長くなりすぎないように注意する. https://www.mhlw.go.jp/content/001204942.pdf
// - WHO 2020 guidelines: adults 150–300 min moderate or 75–150 min vigorous aerobic activity per week
//   (or an equivalent combination), muscle strengthening on 2+ days, limit sedentary time.
//   https://pmc.ncbi.nlm.nih.gov/articles/PMC7719906/
// - Oura: the daily activity goal is the profile baseline adjusted by Readiness (raised above 85, lowered below 70);
//   Activity Score contributors: inactive time under 8 h/day, move 2–3 min after 50 min inactive,
//   meet the goal on most days, medium/high activity 3–4×/week (≥100 MET-min/day),
//   training volume 2,000 MET-min/week, 1–2 easier days per week.
//   https://support.ouraring.com/hc/en-us/articles/360055901214-Activity-Contributors
//   https://support.ouraring.com/hc/en-us/articles/8945980160659-Edit-Activity-Goal
import type { ActivityMode, ActivityPlan } from "../../../shared/types";

export const ACTIVITY_STANDARDS = {
  /** 厚労省ガイド2023（成人）: 3メッツ以上 1日60分 ≒ 8,000歩 */
  steps_per_day: 8000,
  /** good readiness (Oura raises its own goal above 85) → aim higher */
  steps_per_day_high_readiness: 10000,
  /** active recovery day: still a concrete, easy amount */
  steps_recovery: 6000,
  /** very low readiness / raised temperature */
  steps_rest: 4000,
  /** WHO 2020: 150–300 min moderate-equivalent per week */
  mvpa_min_week: 150,
  mvpa_goal_week: 300,
  /** WHO ≥2 days, 厚労省 週2〜3日 */
  strength_days_week: 2,
  /** Oura training volume for a full contributor score */
  met_minutes_week: 2000,
  /** Oura: inactive time under 8 h/day; nudge from 6 h on */
  sedentary_nudge_min: 360,
  /** Oura move reminder fires after 50 minutes */
  move_every_min: 50,
  /** readiness below which the plan becomes active recovery / rest */
  readiness_recovery: 60,
  readiness_rest: 50,
  /** temperature deviation (°C) treated as an illness signal */
  temp_recovery: 0.5,
  temp_rest: 1.0,
  /** conversion: equivalent walking meters → steps, steps → brisk-walk minutes */
  stride_m: 0.7,
  brisk_steps_per_min: 105,
} as const;

export type ActivityDayInput = {
  day: string;
  steps?: number | null;
  readiness_score?: number | null;
  temperature_deviation?: number | null;
  activity_score?: number | null;
  activity_contributors_json?: string | null;
  active_calories?: number | null;
  target_calories?: number | null;
  target_meters?: number | null;
  meters_to_target?: number | null;
  equivalent_walking_distance?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  sedentary_time?: number | null;
  high_activity_met_minutes?: number | null;
  medium_activity_met_minutes?: number | null;
  inactivity_alerts?: number | null;
};

const S = ACTIVITY_STANDARDS;
const n = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** "4,200" without relying on Intl in every runtime */
export const fmtInt = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;
/** steps → brisk-walk minutes, rounded up to 5 min */
export const walkMinutes = (steps: number) => (steps <= 0 ? 0 : Math.max(5, ceilTo(steps / S.brisk_steps_per_min, 5)));

/** Monday of the JST calendar week containing `day` (YYYY-MM-DD). */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return new Date(d.getTime() - offset * 86400e3).toISOString().slice(0, 10);
}

/** Moderate-equivalent minutes of medium+high activity (WHO: 1 min vigorous ≈ 2 min moderate). */
export function mvpaMinutes(d: Pick<ActivityDayInput, "medium_activity_time" | "high_activity_time">): number | null {
  const med = n(d.medium_activity_time), high = n(d.high_activity_time);
  if (med == null && high == null) return null;
  return Math.round(((med ?? 0) + 2 * (high ?? 0)) / 60);
}

function parseContributors(json: string | null | undefined): Record<string, number> | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw ?? {})) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

function decideMode(readiness: number | null, temp: number | null): { mode: ActivityMode; reason: string | null } {
  const tempTxt = temp != null ? `体温が平常より+${temp.toFixed(1)}℃` : "";
  if ((readiness != null && readiness < S.readiness_rest) || (temp != null && temp >= S.temp_rest))
    return { mode: "rest", reason: temp != null && temp >= S.temp_rest ? tempTxt : `コンディション${readiness}` };
  if ((readiness != null && readiness < S.readiness_recovery) || (temp != null && temp >= S.temp_recovery))
    return { mode: "recovery", reason: temp != null && temp >= S.temp_recovery ? tempTxt : `コンディション${readiness}` };
  return { mode: "push", reason: null };
}

export type ActivityPlanInput = {
  /** ISO JST, e.g. 2026-10-21T15:00:00+09:00 */
  now: string;
  /** JST day */
  today: string;
  /** oura_daily rows, any order; only this calendar week (and the latest row) are used */
  days: ActivityDayInput[];
  /** JST days on which a training session was logged */
  strength_days: string[];
  trained_today: boolean;
};

/**
 * Today's target and this week's tally. Push mode floors Oura's own (readiness-adjusted) target at the
 * 厚労省 8,000 steps, so a lenient Oura goal never lowers the bar; low readiness or a raised temperature
 * switches to active recovery / rest with a smaller but still concrete amount. Returns null without any Oura row.
 */
export function buildActivityPlan(input: ActivityPlanInput): ActivityPlan | null {
  const { today } = input;
  const sorted = [...input.days].filter((d) => d?.day && d.day <= today).sort((a, b) => a.day.localeCompare(b.day));
  if (!sorted.length) return null;
  const latest = sorted[sorted.length - 1]!;
  const isToday = latest.day === today;
  const t: ActivityDayInput = isToday ? latest : { day: today };
  const hour = Number(input.now.slice(11, 13));

  const { mode, reason } = decideMode(n(t.readiness_score), n(t.temperature_deviation));
  const readiness = n(t.readiness_score);
  const floor: number = mode === "rest" ? S.steps_rest : mode === "recovery" ? S.steps_recovery
    : readiness != null && readiness >= 85 ? S.steps_per_day_high_readiness : S.steps_per_day;

  const steps = n(t.steps);
  const guidelineLeft = steps != null ? Math.max(0, floor - steps) : null;
  let source: ActivityPlan["source"] = "guideline";
  let stepsLeft = guidelineLeft;
  let stepsTarget = floor;
  const targetM = n(t.target_meters);
  if (mode === "push" && targetM != null && targetM > 0) {
    const metersLeft = n(t.meters_to_target) ?? Math.max(0, targetM - (n(t.equivalent_walking_distance) ?? 0));
    const ouraLeft = Math.ceil(metersLeft / S.stride_m);
    if (guidelineLeft == null || ouraLeft > guidelineLeft) {
      source = "oura"; stepsLeft = ouraLeft;
      stepsTarget = (steps ?? 0) + ouraLeft;
      if (stepsTarget < floor) stepsTarget = floor;
    }
  }
  if (stepsLeft != null) stepsLeft = stepsLeft > 0 ? ceilTo(stepsLeft, 100) : 0;
  stepsTarget = ceilTo(stepsTarget, 100);

  // Week (Mon–Sun JST)
  const start = weekStart(today);
  const weekDays = sorted.filter((d) => d.day >= start);
  const dayIndex = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400e3);
  let mvpa = 0, vig = 0, met = 0, withData = 0, goalDays = 0;
  for (const d of weekDays) {
    const m = mvpaMinutes(d);
    if (m != null || n(d.steps) != null) withData++;
    mvpa += m ?? 0;
    vig += Math.round((n(d.high_activity_time) ?? 0) / 60);
    met += (n(d.medium_activity_met_minutes) ?? 0) + (n(d.high_activity_met_minutes) ?? 0);
    const tm = n(d.target_meters);
    if (n(d.meters_to_target) === 0 || (tm != null && tm > 0 && (n(d.equivalent_walking_distance) ?? 0) >= tm)) goalDays++;
  }
  const strengthDays = new Set(input.strength_days.filter((d) => d >= start && d <= today));
  if (input.trained_today) strengthDays.add(today);

  const plan: ActivityPlan = {
    day: latest.day, is_today: isToday, mode, reason, source,
    steps, steps_target: stepsTarget, steps_left: stepsLeft,
    walk_minutes_left: stepsLeft != null ? walkMinutes(stepsLeft) : null,
    oura: {
      target_meters: targetM, equivalent_walking_distance: n(t.equivalent_walking_distance), meters_to_target: n(t.meters_to_target),
      active_calories: n(t.active_calories), target_calories: n(t.target_calories), activity_score: n(t.activity_score),
      contributors: parseContributors(t.activity_contributors_json),
    },
    mvpa_today_min: mvpaMinutes(t),
    sedentary_min: n(t.sedentary_time) != null ? Math.round((t.sedentary_time as number) / 60) : null,
    inactivity_alerts: n(t.inactivity_alerts),
    week: {
      start, days_left: Math.max(1, 7 - dayIndex), days_with_data: withData,
      mvpa_min: mvpa, mvpa_min_target: S.mvpa_min_week, mvpa_min_goal: S.mvpa_goal_week, vigorous_min: vig,
      met_minutes: Math.round(met), met_minutes_target: S.met_minutes_week,
      strength_days: strengthDays.size, strength_days_target: S.strength_days_week,
      goal_days_met: goalDays,
    },
    advice: [],
  };
  plan.advice = activityAdvice(plan, { hour, trained_today: input.trained_today });
  return plan;
}

/** Short Japanese advice lines (most important first). No emoji / pictographs. */
export function activityAdvice(p: ActivityPlan, opts: { hour: number; trained_today: boolean }): string[] {
  const { hour } = opts;
  const lines: string[] = [];
  const w = p.week;
  const left = p.steps_left, mins = p.walk_minutes_left ?? 0;
  const mvpaShort = Math.max(0, w.mvpa_min_target - w.mvpa_min);
  const perDay = (total: number) => Math.min(60, Math.max(10, ceilTo(total / w.days_left, 5)));

  /* headline */
  if (p.mode !== "push") {
    const easy = p.mode === "rest" ? "休養優先" : "積極的休養の日";
    if (left == null) lines.push(`${p.reason}。今日は${easy}：強い運動は控え、ゆっくり歩いて${fmtInt(p.steps_target)}歩を目安に。`);
    else if (left > 0) lines.push(`${p.reason}。今日は${easy}：強い運動は控え、ゆっくり歩いて${fmtInt(p.steps_target)}歩（あと${fmtInt(left)}歩 ≒ ${mins}分）。`);
    else lines.push(`${p.reason}。今日は${easy}。${fmtInt(p.steps_target)}歩は達成なので、強い運動は控えてストレッチと早めの就寝を。`);
  } else if (left == null) {
    lines.push(`今日の目安は${fmtInt(p.steps_target)}歩（早歩き約${walkMinutes(p.steps_target)}分相当）と中〜高強度の運動。Ouraを同期すると残りを計算します。`);
  } else if (left > 0) {
    const pre = opts.trained_today ? "筋トレ済み。" : "";
    if (hour < 12) {
      const src = p.source === "oura" ? "Ouraの目標" : p.steps_target > S.steps_per_day ? "コンディション良好のため上積み" : "厚労省の目安";
      lines.push(`${pre}今日の目標は${fmtInt(p.steps_target)}歩（${src}）。あと${fmtInt(left)}歩 ≒ 早歩き${mins}分、昼までに半分を。`);
    } else if (hour < 21) {
      const plan = mins > 30 ? `今から30分、夜にもう${mins - 30}分歩きましょう。` : `今から${mins}分歩けば届きます。`;
      lines.push(`${pre}${hour}時で${fmtInt(p.steps ?? 0)}歩。目標${fmtInt(p.steps_target)}歩まであと${fmtInt(left)}歩 ≒ 早歩き${mins}分。${plan}`);
    } else {
      lines.push(`${pre}目標まであと${fmtInt(left)}歩。寝る前に10分歩き、明日は午前から${fmtInt(p.steps_target)}歩を取りにいきましょう。`);
    }
  } else if (w.mvpa_min < w.mvpa_min_target) {
    lines.push(`歩数目標クリア。今週の中〜高強度は残り${mvpaShort}分、今日は${perDay(mvpaShort)}分の早歩きかジョグを足しましょう。`);
  } else if (w.strength_days < w.strength_days_target && !opts.trained_today) {
    lines.push(`歩数と有酸素はクリア。今週の筋トレは${w.strength_days}日なので、今日やって${w.strength_days + 1}日に（週2〜3日が目安）。`);
  } else if (w.mvpa_min < w.mvpa_min_goal) {
    lines.push(`目標クリア。今週の中〜高強度は${w.mvpa_min}分、余力があれば${w.mvpa_min_goal}分まで上積みを。`);
  } else {
    lines.push(`目標クリア。今週の中〜高強度${w.mvpa_min}分・筋トレ${w.strength_days}日で基準を満たしています。`);
  }

  /* hourly movement (all modes: standing breaks are fine on recovery days too) */
  if (p.is_today && ((p.sedentary_min != null && p.sedentary_min >= S.sedentary_nudge_min) || (p.inactivity_alerts ?? 0) >= 3)) {
    const sed = p.sedentary_min != null ? `座っている時間が${Math.floor(p.sedentary_min / 60)}時間${String(p.sedentary_min % 60).padStart(2, "0")}分。` : `座りすぎの通知が${p.inactivity_alerts}回。`;
    lines.push(`${sed}${S.move_every_min}分ごとに立って2〜3分歩きましょう（目安は1日8時間未満）。`);
  }

  /* weekly checks (push only; recovery days should not chase volume) */
  if (p.mode === "push") {
    if (w.days_with_data > 0 && !lines[0]!.includes("中〜高強度")) {
      if (w.mvpa_min < w.mvpa_min_target) lines.push(`今週の中〜高強度は${w.mvpa_min}分。WHO基準の${w.mvpa_min_target}分まで残り${mvpaShort}分（1日${perDay(mvpaShort)}分）。`);
      else if (w.mvpa_min < w.mvpa_min_goal) lines.push(`今週の中〜高強度は${w.mvpa_min}分で基準クリア。${w.mvpa_min_goal}分まで残り${w.mvpa_min_goal - w.mvpa_min}分。`);
    }
    if (w.strength_days < w.strength_days_target && !lines[0]!.includes("筋トレは")) {
      lines.push(`今週の筋トレは${w.strength_days}日。週2〜3日が目安なので、あと${w.strength_days_target - w.strength_days}日。`);
    }
  } else if (p.mode === "recovery") {
    lines.push("中〜高強度の運動と筋トレは、コンディションが戻ってから。");
  }
  return lines;
}

/** One-paragraph description of the standards, for AI system prompts. */
export const ACTIVITY_STANDARDS_PROMPT = [
  "身体活動の基準: 厚労省ガイド2023（成人）は3メッツ以上の身体活動を1日60分以上（約8,000歩）、息が弾む運動を週60分以上、筋トレ週2〜3日、座りっぱなしを避ける。",
  "WHO2020は中強度週150〜300分（高強度なら75〜150分）と筋トレ週2日以上。Ouraは非活動8時間未満、50分ごとに2〜3分動く、週2,000メッツ・分。",
  "health.activity に今日の目標（steps_target, steps_left, walk_minutes_left）と今週の集計がある。mode=push のときは「あと何歩・何分」の具体量で、はっきり多めに動くよう勧める。",
  "mode=recovery/rest のときだけ強度を下げるが、歩数などの具体的な目安は必ず示す。",
].join("");
