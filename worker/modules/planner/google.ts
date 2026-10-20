// Read-only Google Calendar (primary) fetch using a token stored in integration_tokens (provider 'google_calendar').
import type { Env } from "../../env";
import { one, run } from "../../core/db";
import { normalizeGoogleEvent, type GoogleEvent } from "./logic";

export const PROVIDER = "google_calendar";

type StoredToken = { access_token?: string; refresh_token?: string; expires_at?: string };

export async function loadToken(env: Env, userId: string): Promise<StoredToken | null> {
  const row = await one<{ token_json: string }>(env.DB, "SELECT token_json FROM integration_tokens WHERE user_id=? AND provider=?", userId, PROVIDER);
  if (!row) return null;
  try { return JSON.parse(row.token_json) as StoredToken; } catch { return null; }
}

async function saveToken(env: Env, userId: string, tok: StoredToken) {
  await run(env.DB,
    "INSERT INTO integration_tokens (user_id, provider, token_json, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,provider) DO UPDATE SET token_json=excluded.token_json, updated_at=datetime('now')",
    userId, PROVIDER, JSON.stringify(tok));
}

async function refreshAccessToken(env: Env, userId: string, tok: StoredToken): Promise<string | null> {
  if (!tok.refresh_token || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: tok.refresh_token, grant_type: "refresh_token" }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  const next: StoredToken = { ...tok, access_token: data.access_token, expires_at: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString() };
  await saveToken(env, userId, next);
  return data.access_token;
}

/**
 * Events of the primary calendar for [from, to) (JST dates). Never throws: returns `error` instead so the UI can show "未取得".
 */
export async function fetchGoogleEvents(env: Env, userId: string, from: string, to: string): Promise<{ connected: boolean; items: GoogleEvent[]; error?: string }> {
  const tok = await loadToken(env, userId);
  if (!tok || (!tok.access_token && !tok.refresh_token)) return { connected: false, items: [] };

  let access = tok.access_token ?? null;
  const expired = tok.expires_at ? Date.parse(tok.expires_at) < Date.now() + 60_000 : false;
  if (!access || expired) access = (await refreshAccessToken(env, userId, tok)) ?? access;
  if (!access) return { connected: true, items: [], error: "token" };

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", `${from}T00:00:00+09:00`);
  url.searchParams.set("timeMax", `${to}T00:00:00+09:00`);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");

  const call = (token: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  let res = await call(access);
  if (res.status === 401) {
    const fresh = await refreshAccessToken(env, userId, tok);
    if (!fresh) return { connected: true, items: [], error: "unauthorized" };
    res = await call(fresh);
  }
  if (!res.ok) return { connected: true, items: [], error: `http_${res.status}` };
  const data = (await res.json()) as { items?: unknown[] };
  const items = (data.items ?? []).map(normalizeGoogleEvent).filter((e): e is GoogleEvent => e !== null);
  return { connected: true, items };
}
