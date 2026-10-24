import { describe, it, expect } from "vitest";
import type { LifeContext } from "../../shared/types";
import { buildBriefing, normalizeAction, normalizeActions, actionToRow, fmtDur } from "../../worker/modules/assistant/logic";

const ctx = (over: Partial<LifeContext> = {}): LifeContext => ({
  now: "2026-10-21T09:00:00+09:00",
  user: { name: "n" },
  health: { oura: null, oura_is_today: false, pressure: null, checkup_latest: null, meal_summary: null, beauty_routine_count: 0, activity: null },
  training: { trained_today: false, last_session: null, sessions_7d: 0 },
  planner: { tasks_open: 0, events_today: [], reminders_pending: 0 },
  money: { card_month_total: null, card_budget: null, card_budget_left: null, personal_jpy_cash: null, cash_is_fresh: false },
  fx: { open_positions: 0, connector_online: false },
  notes: [],
  ...over,
});

describe("buildBriefing", () => {
  it("reports missing sleep as 未取得 and never invents numbers", () => {
    const b = buildBriefing(ctx());
    expect(b.sleep).toBeNull();
    expect(b.card_budget_left).toBeNull();
    expect(b.pressure).toBeNull();
    const ids = b.chips.map((c) => c.id);
    expect(ids).toEqual(["sleep", "training", "tasks", "events"]);
    expect(b.chips[0].label).toBe("睡眠 未取得");
    expect(b.chips.find((c) => c.id === "training")?.label).toBe("筋トレ 未");
  });
  it("shapes sleep / readiness / budget / pressure chips with tones", () => {
    const b = buildBriefing(ctx({
      health: { oura: { day: "2026-10-21", sleep_duration_sec: 6 * 3600 + 30 * 60, sleep_score: 62, readiness_score: 65, steps: 100, hrv: null, resting_hr: null, sleep_balance: null }, oura_is_today: true, pressure: { current: 1000, delta3h: -3, delta6h: -5, range12h: 6, level: "caution", direction: "down", missing: false }, checkup_latest: null, meal_summary: null, beauty_routine_count: 0, activity: null },
      training: { trained_today: true, last_session: { part: "胸", started_at: "2026-10-21T00:00:00Z" }, sessions_7d: 2 },
      planner: { tasks_open: 7, events_today: [{ title: "打合せ", start_at: "2026-10-21T10:00:00+09:00" }], reminders_pending: 1 },
      money: { card_month_total: 120000, card_budget: 100000, card_budget_left: -20000, personal_jpy_cash: null, cash_is_fresh: false },
    }));
    expect(b.sleep?.duration_sec).toBe(23400);
    expect(b.next_event?.title).toBe("打合せ");
    expect(b.events_today).toBe(1);
    const by = Object.fromEntries(b.chips.map((c) => [c.id, c]));
    expect(by.sleep.label).toBe("睡眠 6h30m · 62");
    expect(by.sleep.tone).toBe("orange");
    expect(by.readiness.tone).toBe("orange");
    expect(by.training.label).toBe("筋トレ 済");
    expect(by.tasks.tone).toBe("orange");
    expect(by.budget.label).toBe("予算残り -20,000円");
    expect(by.budget.tone).toBe("red");
    expect(by.pressure.label).toBe("気圧 注意");
  });
  it("marks stale oura values as 前回 and omits unknown pressure", () => {
    const b = buildBriefing(ctx({ health: { oura: { day: "2026-10-19", sleep_duration_sec: 7 * 3600, sleep_score: 80, readiness_score: null, steps: null, hrv: null, resting_hr: null, sleep_balance: null }, oura_is_today: false, pressure: { current: null, delta3h: null, delta6h: null, range12h: null, level: "unknown", direction: null, missing: true }, checkup_latest: null, meal_summary: null, beauty_routine_count: 0, activity: null } }));
    expect(b.chips[0].label).toBe("睡眠 7h00m · 80（前回）");
    expect(b.chips.some((c) => c.id === "pressure")).toBe(false);
    expect(b.chips.some((c) => c.id === "readiness")).toBe(false);
  });
  it("fmtDur", () => { expect(fmtDur(null)).toBe("—"); expect(fmtDur(5 * 3600 + 5 * 60)).toBe("5h05m"); });
});

describe("normalizeAction", () => {
  it("accepts the three types and trims/collapses titles", () => {
    expect(normalizeAction({ type: "task", title: "  散歩  に行く " })).toEqual({ type: "task", title: "散歩 に行く" });
    expect(normalizeAction({ type: "Reminder", title: "水", when: "2026-10-22" })).toEqual({ type: "reminder", title: "水", when: "2026-10-22" });
    expect(normalizeAction({ type: "note", title: "方針" })).toEqual({ type: "note", title: "方針" });
  });
  it("rejects unknown types, empty titles and junk", () => {
    expect(normalizeAction({ type: "email", title: "x" })).toBeNull();
    expect(normalizeAction({ type: "task", title: "   " })).toBeNull();
    expect(normalizeAction({ type: "task" })).toBeNull();
    expect(normalizeAction(null)).toBeNull();
    expect(normalizeAction("task")).toBeNull();
  });
  it("drops invalid when, caps title length", () => {
    expect(normalizeAction({ type: "task", title: "x", when: "明日" })).toEqual({ type: "task", title: "x" });
    expect(normalizeAction({ type: "task", title: "a".repeat(500) })!.title.length).toBe(200);
  });
});

describe("normalizeActions", () => {
  it("accepts an array or {actions}, de-duplicates and caps at 3", () => {
    const raw = [
      { type: "task", title: "A" }, { type: "task", title: "A" }, { type: "bogus", title: "B" }, { type: "note", title: "" },
      { type: "reminder", title: "C" }, { type: "note", title: "D" }, { type: "task", title: "E" },
    ];
    expect(normalizeActions(raw).map((a) => a.title)).toEqual(["A", "C", "D"]);
    expect(normalizeActions({ actions: raw }).length).toBe(3);
    expect(normalizeActions("nope")).toEqual([]);
    expect(normalizeActions({ actions: "nope" })).toEqual([]);
  });
});

describe("actionToRow", () => {
  it("task uses the date part of when", () => {
    expect(actionToRow({ type: "task", title: "t" }, "2026-10-21")).toEqual({ table: "planner_items", type: "task", title: "t", date: null, remind_at: null });
    expect(actionToRow({ type: "task", title: "t", when: "2026-10-22T10:00:00+09:00" }, "2026-10-21").date).toBe("2026-10-22");
  });
  it("reminder defaults to tomorrow 09:00 JST, bare date → 09:00 JST", () => {
    const r = actionToRow({ type: "reminder", title: "r" }, "2026-10-21");
    expect(r.table === "planner_items" && r.remind_at).toBe("2026-10-22T00:00:00.000Z");
    const r2 = actionToRow({ type: "reminder", title: "r", when: "2026-10-25" }, "2026-10-21");
    expect(r2.table === "planner_items" && r2.remind_at).toBe("2026-10-25T00:00:00.000Z");
  });
  it("note maps to notes/other", () => {
    expect(actionToRow({ type: "note", title: "n" }, "2026-10-21")).toEqual({ table: "notes", category: "other", content: "n" });
  });
});
