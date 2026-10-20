// Pure planner logic (no D1 / fetch) so it can be unit-tested.
export type PlannerType = "task" | "reminder" | "event";
export const PLANNER_TYPES: PlannerType[] = ["task", "reminder", "event"];

export type PlannerItem = {
  id: string;
  type: PlannerType;
  title: string;
  notes: string | null;
  date: string | null;       // YYYY-MM-DD (tasks)
  start_at: string | null;   // ISO (events)
  end_at: string | null;     // ISO (events)
  remind_at: string | null;  // ISO (reminders)
  reminded_at: string | null;
  done_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduleFields = Pick<PlannerItem, "date" | "start_at" | "end_at" | "remind_at">;

export type GoogleEvent = { id: string; title: string; start_at: string; end_at: string; all_day: boolean; html_link: string | null };

const JST_OFFSET_MS = 9 * 3600 * 1000;
export const MIN_EVENT_MIN = 15;
export const DEFAULT_EVENT_MIN = 60;

/** JST calendar date (YYYY-MM-DD) of an ISO timestamp. Returns null for invalid input. */
export function jstDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The date an item is placed on in the calendar, or null when undated. */
export function anchorDate(item: Pick<PlannerItem, "type" | "date" | "start_at" | "remind_at">): string | null {
  switch (item.type) {
    case "task": return item.date ?? null;
    case "event": return jstDateOf(item.start_at);
    case "reminder": return jstDateOf(item.remind_at);
  }
}

export const isScheduled = (item: Pick<PlannerItem, "type" | "date" | "start_at" | "remind_at">) => anchorDate(item) !== null;

/** [from, to) on JST calendar dates. */
export function inRange(item: Pick<PlannerItem, "type" | "date" | "start_at" | "remind_at">, from: string, to: string): boolean {
  const d = anchorDate(item);
  return d !== null && d >= from && d < to;
}

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/**
 * Split a user's live items into what the week view needs:
 * - items: scheduled, not-done items inside [from, to)
 * - undated: items without a date/time (not done)
 * - done: completed tasks (any date), newest first
 */
export function splitItems(all: PlannerItem[], from: string, to: string) {
  const live = all.filter((i) => !i.archived_at);
  const done = live.filter((i) => i.done_at).sort((a, b) => (b.done_at! < a.done_at! ? -1 : 1));
  const open = live.filter((i) => !i.done_at);
  const items = open.filter((i) => inRange(i, from, to)).sort(sortByTime);
  const undated = open.filter((i) => !isScheduled(i)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { items, undated, done };
}

function sortByTime(a: PlannerItem, b: PlannerItem) {
  const ka = `${anchorDate(a)}|${a.start_at ?? a.remind_at ?? ""}`;
  const kb = `${anchorDate(b)}|${b.start_at ?? b.remind_at ?? ""}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Round minutes to the nearest 15-minute step. */
export const snap15 = (minutes: number) => Math.round(minutes / 15) * 15;

/**
 * Keep only the fields that make sense for the type:
 * task → date; event → start_at/end_at (end defaults to +60min, never before start+15min); reminder → remind_at.
 */
export function normalizeFields(type: PlannerType, input: Partial<ScheduleFields>): ScheduleFields {
  const empty: ScheduleFields = { date: null, start_at: null, end_at: null, remind_at: null };
  if (type === "task") return { ...empty, date: input.date ?? null };
  if (type === "reminder") return { ...empty, remind_at: input.remind_at ?? null };
  // event
  if (!input.start_at) return empty;
  const start = Date.parse(input.start_at);
  if (Number.isNaN(start)) return empty;
  let end = input.end_at ? Date.parse(input.end_at) : NaN;
  if (Number.isNaN(end) || end < start + MIN_EVENT_MIN * 60000) end = start + (Number.isNaN(end) ? DEFAULT_EVENT_MIN : MIN_EVENT_MIN) * 60000;
  return { ...empty, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() };
}

export type PlannerPatch = Partial<ScheduleFields> & { title?: string; notes?: string | null; done?: boolean; unschedule?: boolean };

/**
 * Apply a patch to an item and return the new column values. Pure: `now` is injected.
 * - unschedule clears date/start/end/remind (a reminder then stops firing from cron)
 * - a changed remind_at resets reminded_at so the new time fires again
 */
export function applyPatch(item: PlannerItem, patch: PlannerPatch, now: string): PlannerItem {
  const next: PlannerItem = { ...item, updated_at: now };
  if (patch.title !== undefined) next.title = patch.title.trim();
  if (patch.notes !== undefined) next.notes = patch.notes?.trim() ? patch.notes.trim() : null;
  if (patch.done !== undefined) next.done_at = patch.done ? now : null;
  const touchesSchedule = patch.unschedule || ["date", "start_at", "end_at", "remind_at"].some((k) => k in patch);
  if (touchesSchedule) {
    const fields = patch.unschedule
      ? normalizeFields(item.type, {})
      : normalizeFields(item.type, {
          date: patch.date !== undefined ? patch.date : item.date,
          start_at: patch.start_at !== undefined ? patch.start_at : item.start_at,
          end_at: patch.end_at !== undefined ? patch.end_at : (patch.start_at !== undefined ? shiftEnd(item, patch.start_at) : item.end_at),
          remind_at: patch.remind_at !== undefined ? patch.remind_at : item.remind_at,
        });
    Object.assign(next, fields);
    if (fields.remind_at !== item.remind_at) next.reminded_at = null;
  }
  return next;
}

/** When only start_at moves, keep the event's duration. */
function shiftEnd(item: PlannerItem, newStart: string | null): string | null {
  if (!newStart || !item.start_at || !item.end_at) return item.end_at;
  const dur = Date.parse(item.end_at) - Date.parse(item.start_at);
  const s = Date.parse(newStart);
  if (Number.isNaN(s) || Number.isNaN(dur) || dur <= 0) return null;
  return new Date(s + dur).toISOString();
}

/** Weekday tone for headers: Saturday blue, Sunday red. `date` is YYYY-MM-DD. */
export function dayTone(date: string): "blue" | "red" | null {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 6 ? "blue" : dow === 0 ? "red" : null;
}

export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;
export function weekdayLabel(date: string): string {
  return WEEKDAY_JA[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/** Normalize a Google Calendar API v3 event resource. Returns null for cancelled / malformed events. */
export function normalizeGoogleEvent(raw: unknown): GoogleEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { id?: string; status?: string; summary?: string; htmlLink?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } };
  if (!e.id || e.status === "cancelled") return null;
  if (e.start?.dateTime) {
    const s = Date.parse(e.start.dateTime);
    const en = e.end?.dateTime ? Date.parse(e.end.dateTime) : s + DEFAULT_EVENT_MIN * 60000;
    if (Number.isNaN(s)) return null;
    return { id: e.id, title: e.summary?.trim() || "(無題)", start_at: new Date(s).toISOString(), end_at: new Date(Number.isNaN(en) ? s + DEFAULT_EVENT_MIN * 60000 : en).toISOString(), all_day: false, html_link: e.htmlLink ?? null };
  }
  if (e.start?.date) {
    // All-day: Google's end.date is exclusive; store JST midnight boundaries.
    const endDate = e.end?.date ?? addDays(e.start.date, 1);
    return { id: e.id, title: e.summary?.trim() || "(無題)", start_at: `${e.start.date}T00:00:00+09:00`, end_at: `${endDate}T00:00:00+09:00`, all_day: true, html_link: e.htmlLink ?? null };
  }
  return null;
}
