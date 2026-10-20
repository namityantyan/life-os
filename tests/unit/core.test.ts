import { describe, it, expect } from "vitest";
import { suggestAction } from "../../worker/core/context";
import type { LifeContext } from "../../shared/types";

const base = (over: Partial<LifeContext> = {}): LifeContext => ({
  now: "2026-10-21T09:00:00+09:00",
  user: { name: "n" },
  health: { oura: null, oura_is_today: false, pressure: null, checkup_latest: null, meal_summary: null, beauty_routine_count: 0 },
  training: { trained_today: false, last_session: null, sessions_7d: 0 },
  planner: { tasks_open: 0, events_today: [], reminders_pending: 0 },
  money: { card_month_total: null, card_budget: null, card_budget_left: null, personal_jpy_cash: null, cash_is_fresh: false },
  fx: { open_positions: 0, connector_online: false },
  notes: [],
  ...over,
});
const oura = (o: Partial<NonNullable<LifeContext["health"]["oura"]>>) => ({ day: "2026-10-21", sleep_duration_sec: 7 * 3600, sleep_score: 80, readiness_score: 80, steps: 6000, hrv: 40, resting_hr: 55, sleep_balance: 80, ...o });

describe("suggestAction", () => {
  it("asks to sync when today's Oura data is missing", () => {
    expect(suggestAction(base())).toMatch(/未同期/);
  });
  it("never treats yesterday's Oura values as today's", () => {
    const ctx = base({ health: { ...base().health, oura: oura({ readiness_score: 40, day: "2026-10-20" }), oura_is_today: false } });
    expect(suggestAction(ctx)).not.toMatch(/回復度が低め/);
  });
  it("suggests rest when readiness is low today", () => {
    const ctx = base({ health: { ...base().health, oura: oura({ readiness_score: 50 }), oura_is_today: true } });
    expect(suggestAction(ctx)).toMatch(/回復度が低め/);
    expect(suggestAction({ ...ctx, now: "2026-10-21T20:00:00+09:00" })).toMatch(/就寝/);
  });
  it("does not push extra load after a logged workout", () => {
    const ctx = base({ training: { trained_today: true, last_session: { part: "胸", started_at: "2026-10-21T08:00:00Z" }, sessions_7d: 2 }, health: { ...base().health, oura: oura({}), oura_is_today: true } });
    expect(suggestAction(ctx)).toMatch(/追加の負荷は不要/);
  });
  it("suggests a walk when steps are low in the afternoon", () => {
    const ctx = base({ now: "2026-10-21T16:00:00+09:00", health: { ...base().health, oura: oura({ steps: 1200 }), oura_is_today: true } });
    expect(suggestAction(ctx)).toMatch(/散歩/);
  });
});
