import { describe, it, expect } from "vitest";
import {
  addDays, anchorDate, applyPatch, dayTone, inRange, isScheduled, jstDateOf, normalizeFields, normalizeGoogleEvent, snap15, splitItems, weekdayLabel,
  type PlannerItem,
} from "../../worker/modules/planner/logic";

const base = (over: Partial<PlannerItem> = {}): PlannerItem => ({
  id: "x", type: "task", title: "t", notes: null, date: null, start_at: null, end_at: null, remind_at: null, reminded_at: null,
  done_at: null, archived_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over,
});

describe("dates", () => {
  it("jstDateOf converts UTC to the JST calendar date", () => {
    expect(jstDateOf("2026-10-20T15:30:00Z")).toBe("2026-10-21"); // 00:30 JST next day
    expect(jstDateOf("2026-10-20T14:59:00Z")).toBe("2026-10-20");
    expect(jstDateOf(null)).toBeNull();
    expect(jstDateOf("nope")).toBeNull();
  });
  it("addDays handles month boundaries", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
  it("anchorDate depends on type", () => {
    expect(anchorDate(base({ type: "task", date: "2026-10-21", start_at: "2026-10-25T00:00:00Z" }))).toBe("2026-10-21");
    expect(anchorDate(base({ type: "event", start_at: "2026-10-21T01:00:00Z" }))).toBe("2026-10-21");
    expect(anchorDate(base({ type: "reminder", remind_at: "2026-10-21T20:00:00Z" }))).toBe("2026-10-22");
    expect(anchorDate(base({ type: "event" }))).toBeNull();
    expect(isScheduled(base({ type: "reminder" }))).toBe(false);
  });
  it("inRange is [from, to)", () => {
    const t = base({ date: "2026-10-27" });
    expect(inRange(t, "2026-10-21", "2026-10-28")).toBe(true);
    expect(inRange(t, "2026-10-21", "2026-10-27")).toBe(false);
    expect(inRange(base(), "2026-10-21", "2026-10-28")).toBe(false);
  });
});

describe("splitItems", () => {
  const from = "2026-10-21", to = "2026-10-28";
  const items: PlannerItem[] = [
    base({ id: "in", date: "2026-10-22" }),
    base({ id: "out", date: "2026-11-02" }),
    base({ id: "undated", created_at: "2026-10-02T00:00:00Z" }),
    base({ id: "undated-older", created_at: "2026-10-01T00:00:00Z" }),
    base({ id: "done", date: "2026-10-22", done_at: "2026-10-20T00:00:00Z" }),
    base({ id: "done-newer", done_at: "2026-10-21T00:00:00Z" }),
    base({ id: "archived", date: "2026-10-22", archived_at: "2026-10-20T00:00:00Z" }),
    base({ id: "ev", type: "event", start_at: "2026-10-21T00:00:00Z", end_at: "2026-10-21T01:00:00Z" }),
    base({ id: "rem-undated", type: "reminder", created_at: "2026-09-30T00:00:00Z" }),
  ];
  const r = splitItems(items, from, to);
  it("items: scheduled, open, in range, sorted by time", () => {
    expect(r.items.map((i) => i.id)).toEqual(["ev", "in"]);
  });
  it("undated: no date/time and not done, newest first", () => {
    expect(r.undated.map((i) => i.id)).toEqual(["undated", "undated-older", "rem-undated"]);
    expect(r.undated.find((i) => i.id === "done-newer")).toBeUndefined();
  });
  it("done: completed tasks regardless of date, newest first; archived excluded everywhere", () => {
    expect(r.done.map((i) => i.id)).toEqual(["done-newer", "done"]);
    expect([...r.items, ...r.undated, ...r.done].some((i) => i.id === "archived")).toBe(false);
  });
});

describe("normalizeFields", () => {
  it("task keeps only date", () => {
    expect(normalizeFields("task", { date: "2026-10-21", start_at: "2026-10-21T00:00:00Z", remind_at: "2026-10-21T00:00:00Z" }))
      .toEqual({ date: "2026-10-21", start_at: null, end_at: null, remind_at: null });
  });
  it("reminder keeps only remind_at", () => {
    expect(normalizeFields("reminder", { date: "2026-10-21", remind_at: "2026-10-21T00:00:00Z" }))
      .toEqual({ date: null, start_at: null, end_at: null, remind_at: "2026-10-21T00:00:00Z" });
  });
  it("event defaults end to +60min and enforces 15min minimum", () => {
    expect(normalizeFields("event", { start_at: "2026-10-21T01:00:00Z" })).toMatchObject({ start_at: "2026-10-21T01:00:00.000Z", end_at: "2026-10-21T02:00:00.000Z" });
    expect(normalizeFields("event", { start_at: "2026-10-21T01:00:00Z", end_at: "2026-10-21T00:00:00Z" })).toMatchObject({ end_at: "2026-10-21T01:15:00.000Z" });
    expect(normalizeFields("event", { start_at: "2026-10-21T01:00:00Z", end_at: "2026-10-21T03:30:00Z" })).toMatchObject({ end_at: "2026-10-21T03:30:00.000Z" });
  });
  it("event without start is undated", () => {
    expect(normalizeFields("event", { end_at: "2026-10-21T03:30:00Z", date: "2026-10-21" })).toEqual({ date: null, start_at: null, end_at: null, remind_at: null });
  });
});

describe("applyPatch", () => {
  const now = "2026-10-21T09:00:00.000Z";
  it("toggles done and trims title/notes", () => {
    const t = applyPatch(base({ date: "2026-10-21" }), { done: true, title: "  new ", notes: "  " }, now);
    expect(t.done_at).toBe(now); expect(t.title).toBe("new"); expect(t.notes).toBeNull(); expect(t.date).toBe("2026-10-21");
    expect(applyPatch(t, { done: false }, now).done_at).toBeNull();
  });
  it("unschedule clears every schedule field so a reminder stops firing", () => {
    const r = applyPatch(base({ type: "reminder", remind_at: "2026-10-22T00:00:00Z", reminded_at: null }), { unschedule: true }, now);
    expect(r.remind_at).toBeNull(); expect(r.date).toBeNull(); expect(r.start_at).toBeNull();
    const e = applyPatch(base({ type: "event", start_at: "2026-10-22T00:00:00Z", end_at: "2026-10-22T01:00:00Z" }), { unschedule: true }, now);
    expect(e.start_at).toBeNull(); expect(e.end_at).toBeNull();
  });
  it("changing remind_at resets reminded_at; unrelated patch keeps it", () => {
    const r = base({ type: "reminder", remind_at: "2026-10-20T00:00:00Z", reminded_at: "2026-10-20T00:00:05Z" });
    expect(applyPatch(r, { remind_at: "2026-10-25T00:00:00Z" }, now).reminded_at).toBeNull();
    expect(applyPatch(r, { title: "x" }, now).reminded_at).toBe("2026-10-20T00:00:05Z");
  });
  it("moving an event's start keeps its duration; end_at alone resizes", () => {
    const e = base({ type: "event", start_at: "2026-10-22T00:00:00Z", end_at: "2026-10-22T01:30:00Z" });
    const moved = applyPatch(e, { start_at: "2026-10-23T05:00:00Z" }, now);
    expect(moved.end_at).toBe("2026-10-23T06:30:00.000Z");
    const resized = applyPatch(e, { end_at: "2026-10-22T02:15:00Z" }, now);
    expect(resized.start_at).toBe("2026-10-22T00:00:00.000Z"); expect(resized.end_at).toBe("2026-10-22T02:15:00.000Z");
  });
  it("type-specific fields are enforced on patch too", () => {
    const t = applyPatch(base({ date: "2026-10-21" }), { start_at: "2026-10-22T00:00:00Z" }, now);
    expect(t.start_at).toBeNull(); expect(t.date).toBe("2026-10-21");
  });
});

describe("helpers", () => {
  it("snap15", () => { expect(snap15(7)).toBe(0); expect(snap15(8)).toBe(15); expect(snap15(100)).toBe(105); });
  it("dayTone: Saturday blue, Sunday red", () => {
    expect(dayTone("2026-10-24")).toBe("blue"); // Sat
    expect(dayTone("2026-10-25")).toBe("red");  // Sun
    expect(dayTone("2026-10-21")).toBeNull();   // Wed
    expect(weekdayLabel("2026-10-21")).toBe("水");
  });
});

describe("normalizeGoogleEvent", () => {
  it("timed event", () => {
    expect(normalizeGoogleEvent({ id: "g1", summary: " 打合せ ", htmlLink: "https://cal/g1", start: { dateTime: "2026-10-21T10:00:00+09:00" }, end: { dateTime: "2026-10-21T11:00:00+09:00" } }))
      .toEqual({ id: "g1", title: "打合せ", start_at: "2026-10-21T01:00:00.000Z", end_at: "2026-10-21T02:00:00.000Z", all_day: false, html_link: "https://cal/g1" });
  });
  it("all-day event uses exclusive end date", () => {
    expect(normalizeGoogleEvent({ id: "g2", start: { date: "2026-10-21" }, end: { date: "2026-10-23" } }))
      .toEqual({ id: "g2", title: "(無題)", start_at: "2026-10-21T00:00:00+09:00", end_at: "2026-10-23T00:00:00+09:00", all_day: true, html_link: null });
  });
  it("drops cancelled and malformed", () => {
    expect(normalizeGoogleEvent({ id: "g3", status: "cancelled", start: { date: "2026-10-21" } })).toBeNull();
    expect(normalizeGoogleEvent({ id: "g4" })).toBeNull();
    expect(normalizeGoogleEvent(null)).toBeNull();
  });
});
