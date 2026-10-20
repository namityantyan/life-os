// Local-time (browser) date helpers for the week view. The app is used in Asia/Tokyo.
const pad = (n: number) => String(n).padStart(2, "0");

export const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());

export function parseDateStr(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(date: string, n: number): string {
  const d = parseDateStr(date);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}
/** ISO timestamp for `minutes` after local midnight of `date`. */
export function isoAt(date: string, minutes: number): string {
  const d = parseDateStr(date);
  d.setMinutes(minutes);
  return d.toISOString();
}
export const localDateOf = (iso: string) => toDateStr(new Date(iso));
export const minutesOfDay = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
export const fmtTime = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtMD = (date: string) => { const d = parseDateStr(date); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const weekdayJa = (date: string) => ["日", "月", "火", "水", "木", "金", "土"][parseDateStr(date).getDay()];
export const dayTone = (date: string): "blue" | "red" | null => { const w = parseDateStr(date).getDay(); return w === 6 ? "blue" : w === 0 ? "red" : null; };

/** datetime-local <input> value ↔ ISO. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export const snap15 = (m: number) => Math.round(m / 15) * 15;
export const durationMin = (startIso: string, endIso: string) => Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));
