// Pure assistant logic (no D1 / AI) so it can be unit-tested.
import type { LifeContext, PressureLevel } from "../../../shared/types";

export const ACTION_TYPES = ["task", "reminder", "note"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type AssistantAction = { type: ActionType; title: string; when?: string | null };

export const MAX_ACTIONS = 3;
export const MAX_TITLE = 200;

/** A compact "今日の要点" for the panel header. Missing values stay null (never 0 / guessed). */
export type Briefing = {
  sleep: { duration_sec: number | null; score: number | null; readiness: number | null; is_today: boolean } | null;
  trained_today: boolean;
  tasks_open: number;
  events_today: number;
  next_event: { title: string; start_at: string | null } | null;
  card_budget_left: number | null;
  pressure: PressureLevel | null;
  chips: { id: string; label: string; tone: "neutral" | "green" | "orange" | "red" | "accent" }[];
};

const PRESSURE_LABEL: Record<PressureLevel, string> = { stable: "気圧 安定", caution: "気圧 注意", strong: "気圧 強い変化", unknown: "気圧 判定不可" };

export function fmtDur(sec: number | null): string {
  if (sec == null) return "—";
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

export function buildBriefing(ctx: LifeContext): Briefing {
  const o = ctx.health.oura;
  const sleep = o ? { duration_sec: o.sleep_duration_sec, score: o.sleep_score, readiness: o.readiness_score, is_today: ctx.health.oura_is_today } : null;
  const events = ctx.planner.events_today ?? [];
  const pressure = ctx.health.pressure?.level ?? null;
  const chips: Briefing["chips"] = [];

  if (sleep && (sleep.duration_sec != null || sleep.score != null)) {
    const lowish = sleep.score != null && sleep.score < 70;
    chips.push({ id: "sleep", label: `睡眠 ${fmtDur(sleep.duration_sec)}${sleep.score != null ? ` · ${sleep.score}` : ""}${sleep.is_today ? "" : "（前回）"}`, tone: lowish ? "orange" : "neutral" });
  } else chips.push({ id: "sleep", label: "睡眠 未取得", tone: "neutral" });
  if (sleep?.readiness != null) chips.push({ id: "readiness", label: `コンディション ${sleep.readiness}`, tone: sleep.readiness < 70 ? "orange" : "green" });
  chips.push({ id: "training", label: ctx.training.trained_today ? "筋トレ 済" : "筋トレ 未", tone: ctx.training.trained_today ? "green" : "neutral" });
  chips.push({ id: "tasks", label: `タスク ${ctx.planner.tasks_open}件`, tone: ctx.planner.tasks_open > 5 ? "orange" : "neutral" });
  chips.push({ id: "events", label: `予定 ${events.length}件`, tone: events.length ? "accent" : "neutral" });
  if (ctx.money.card_budget_left != null) chips.push({ id: "budget", label: `予算残り ${Math.round(ctx.money.card_budget_left).toLocaleString("ja-JP")}円`, tone: ctx.money.card_budget_left < 0 ? "red" : "neutral" });
  if (pressure && pressure !== "unknown") chips.push({ id: "pressure", label: PRESSURE_LABEL[pressure], tone: pressure === "strong" ? "red" : pressure === "caution" ? "orange" : "green" });

  return {
    sleep, trained_today: ctx.training.trained_today, tasks_open: ctx.planner.tasks_open,
    events_today: events.length, next_event: events[0] ?? null,
    card_budget_left: ctx.money.card_budget_left, pressure, chips,
  };
}

const isIsoLike = (s: string) => !Number.isNaN(Date.parse(s));

/** Validate and normalise one action candidate (from the AI or the client). Returns null when it is unusable. */
export function normalizeAction(raw: unknown): AssistantAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type.trim().toLowerCase() : "";
  if (!(ACTION_TYPES as readonly string[]).includes(type)) return null;
  const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  if (!title) return null;
  let when: string | null = null;
  if (typeof r.when === "string" && r.when.trim()) {
    const w = r.when.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(w) || isIsoLike(w)) when = w;
  }
  return when ? { type: type as ActionType, title, when } : { type: type as ActionType, title };
}

/** De-duplicate and cap a list of raw actions. */
export function normalizeActions(raw: unknown, max = MAX_ACTIONS): AssistantAction[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).actions) ? (raw as any).actions : [];
  const out: AssistantAction[] = []; const seen = new Set<string>();
  for (const item of list) {
    const a = normalizeAction(item); if (!a) continue;
    const key = `${a.type}:${a.title}`; if (seen.has(key)) continue;
    seen.add(key); out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

/** Map an action to the planner / notes row fields it creates. `today` is the JST date. */
export function actionToRow(a: AssistantAction, today: string): { table: "planner_items"; type: "task" | "reminder"; title: string; date: string | null; remind_at: string | null } | { table: "notes"; category: "other"; content: string } {
  if (a.type === "note") return { table: "notes", category: "other", content: a.title };
  if (a.type === "task") {
    const date = a.when && /^\d{4}-\d{2}-\d{2}$/.test(a.when) ? a.when : a.when ? a.when.slice(0, 10) : null;
    return { table: "planner_items", type: "task", title: a.title, date, remind_at: null };
  }
  // reminder: needs a datetime; a bare date becomes 09:00 JST; none → tomorrow 09:00 JST
  let remind = a.when ?? null;
  if (remind && /^\d{4}-\d{2}-\d{2}$/.test(remind)) remind = `${remind}T09:00:00+09:00`;
  if (!remind) {
    const t = new Date(`${today}T00:00:00+09:00`).getTime() + 86400e3 + 9 * 3600e3;
    remind = new Date(t).toISOString();
  }
  return { table: "planner_items", type: "reminder", title: a.title, date: null, remind_at: new Date(remind).toISOString() };
}
