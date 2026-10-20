import type { Env } from "../env";

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}
export async function one<T = Record<string, unknown>>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const r = await db.prepare(sql).bind(...params).first<T>();
  return (r as T) ?? null;
}
export async function run(db: D1Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).bind(...params).run();
}

export async function getSetting<T>(env: Env, userId: string, key: string, fallback: T): Promise<T> {
  const row = await one<{ value_json: string }>(env.DB, "SELECT value_json FROM settings WHERE user_id=? AND key=?", userId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
}
export async function setSetting(env: Env, userId: string, key: string, value: unknown) {
  await run(env.DB,
    "INSERT INTO settings (user_id, key, value_json, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now')",
    userId, key, JSON.stringify(value));
}

/** JST helpers. Life OS displays and reasons in Asia/Tokyo. */
export function jstNow(): Date { return new Date(Date.now() + 9 * 3600 * 1000); }
export function jstDate(d = jstNow()): string { return d.toISOString().slice(0, 10); }
export function jstHour(d = jstNow()): number { return d.getUTCHours(); }
