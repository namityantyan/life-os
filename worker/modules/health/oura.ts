import type { Env } from "../../env";
import { run } from "../../core/db";
import { loadToken } from "../assets/freee";
import { normalizeOura } from "./logic";

const BASE = "https://api.ouraring.com/v2/usercollection";

async function resolveToken(env: Env, userId: string): Promise<string | null> {
  if (env.OURA_ACCESS_TOKEN) return env.OURA_ACCESS_TOKEN;
  // Stored encrypted by 設定 → 接続 (integrations module); shared helper in assets/freee.ts.
  const t = (await loadToken(env, userId, "oura")) as unknown as { access_token?: string; token?: string } | null;
  return t?.access_token ?? t?.token ?? null;
}

async function fetchCollection<T>(token: string, name: string, start: string, end: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${BASE}/${name}`);
    url.searchParams.set("start_date", start); url.searchParams.set("end_date", end);
    if (next) url.searchParams.set("next_token", next);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`oura ${name} ${res.status}`);
    const j = (await res.json()) as { data?: T[]; next_token?: string | null };
    out.push(...(j.data ?? []));
    next = j.next_token ?? null;
    if (!next) break;
  }
  return out;
}

/**
 * Syncs the last 7 days from Oura API v2 into oura_daily. No-op when no token is configured.
 * Called by cron every 10 minutes and by POST /api/health/oura/sync.
 */
export async function syncOura(env: Env, userId: string): Promise<{ synced: number; skipped?: "no_token" }> {
  const token = await resolveToken(env, userId);
  if (!token) return { synced: 0, skipped: "no_token" };
  const end = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const start = new Date(Date.now() + 9 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10);
  const [daily_sleep, daily_readiness, daily_activity, sleep] = await Promise.all([
    fetchCollection<any>(token, "daily_sleep", start, end),
    fetchCollection<any>(token, "daily_readiness", start, end),
    fetchCollection<any>(token, "daily_activity", start, end),
    fetchCollection<any>(token, "sleep", start, end),
  ]);
  const rows = normalizeOura({ daily_sleep, daily_readiness, daily_activity, sleep });
  for (const r of rows) {
    await run(env.DB,
      `INSERT INTO oura_daily (user_id,day,sleep_duration_sec,sleep_score,readiness_score,steps,hrv,resting_hr,sleep_balance,synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(user_id,day) DO UPDATE SET
         sleep_duration_sec=COALESCE(excluded.sleep_duration_sec,oura_daily.sleep_duration_sec),
         sleep_score=COALESCE(excluded.sleep_score,oura_daily.sleep_score),
         readiness_score=COALESCE(excluded.readiness_score,oura_daily.readiness_score),
         steps=COALESCE(excluded.steps,oura_daily.steps),
         hrv=COALESCE(excluded.hrv,oura_daily.hrv),
         resting_hr=COALESCE(excluded.resting_hr,oura_daily.resting_hr),
         sleep_balance=COALESCE(excluded.sleep_balance,oura_daily.sleep_balance),
         synced_at=datetime('now')`,
      userId, r.day, r.sleep_duration_sec, r.sleep_score, r.readiness_score, r.steps, r.hrv, r.resting_hr, r.sleep_balance);
  }
  return { synced: rows.length };
}
