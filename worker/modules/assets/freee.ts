// freee Accounting API: OAuth2 + hourly bank-balance sync (read-only, walletables.last_balance).
import type { Env } from "../../env";
import { all, one, run, newId, getSetting, setSetting } from "../../core/db";
import { isStale } from "./logic";

const AUTH_BASE = "https://accounts.secure.freee.co.jp/public_api";
const API_BASE = "https://api.freee.co.jp";
export const FREEE_SCOPE = "accounting:companies:read accounting:walletables:read";

export type FreeeToken = { access_token: string; refresh_token: string; expires_at: number; scope?: string; companies?: { id: number; name: string }[]; connected_at: string };

/* ---------- encryption at rest (AES-GCM, key = SHA-256(SESSION_SECRET)) ---------- */
async function key(env: Env) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET || "dev-secret"));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encryptJson(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: b64(iv), data: b64(data) });
}
export async function decryptJson<T>(env: Env, stored: string): Promise<T | null> {
  try {
    const p = JSON.parse(stored) as { v: number; iv: string; data: string };
    const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.iv) }, await key(env), unb64(p.data));
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch { return null; }
}

export async function loadToken(env: Env, userId: string, provider = "freee"): Promise<FreeeToken | null> {
  const row = await one<{ token_json: string }>(env.DB, "SELECT token_json FROM integration_tokens WHERE user_id=? AND provider=?", userId, provider);
  return row ? decryptJson<FreeeToken>(env, row.token_json) : null;
}
export async function saveToken(env: Env, userId: string, token: unknown, provider = "freee") {
  await run(env.DB, "INSERT INTO integration_tokens (user_id, provider, token_json, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_id,provider) DO UPDATE SET token_json=excluded.token_json, updated_at=datetime('now')", userId, provider, await encryptJson(env, token));
}
export async function deleteToken(env: Env, userId: string, provider = "freee") {
  await run(env.DB, "DELETE FROM integration_tokens WHERE user_id=? AND provider=?", userId, provider);
}

/* ---------- OAuth ---------- */
export const freeeConfigured = (env: Env) => Boolean(env.FREEE_CLIENT_ID && env.FREEE_CLIENT_SECRET);
export const redirectUri = (origin: string) => `${origin}/api/assets/freee/callback`;

export function authorizeUrl(env: Env, origin: string, state: string): string {
  const u = new URL(`${AUTH_BASE}/authorize`);
  u.searchParams.set("client_id", env.FREEE_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", FREEE_SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "select_company");
  return u.toString();
}

type TokenRes = { access_token: string; refresh_token: string; expires_in: number; scope?: string };
async function tokenRequest(env: Env, params: Record<string, string>): Promise<FreeeToken> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.FREEE_CLIENT_ID ?? "", client_secret: env.FREEE_CLIENT_SECRET ?? "", ...params }),
  });
  if (!res.ok) throw new Error(`freee token: ${res.status}`);
  const t = (await res.json()) as TokenRes;
  if (!acceptableScope(t.scope)) throw new Error(`freee: 許可された権限が想定外です (${t.scope})`);
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in ?? 21600) * 1000 - 60_000, scope: t.scope, connected_at: new Date().toISOString() };
}
/** Only read scopes (new-style companies/walletables read, or legacy `read`), never write. */
export function acceptableScope(scope: string | undefined): boolean {
  if (!scope) return true;
  const parts = scope.split(/\s+/).filter(Boolean);
  const ok = new Set(["accounting:companies:read", "accounting:walletables:read", "default_read", "read"]);
  return parts.every((p) => ok.has(p));
}
export const exchangeCode = (env: Env, origin: string, code: string) => tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(origin) });
export const refreshToken = (env: Env, t: FreeeToken) => tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });

async function validToken(env: Env, userId: string): Promise<FreeeToken | null> {
  const t = await loadToken(env, userId);
  if (!t) return null;
  if (t.expires_at > Date.now()) return t;
  const n = await refreshToken(env, t);
  const merged = { ...t, ...n, companies: t.companies, connected_at: t.connected_at };
  await saveToken(env, userId, merged);
  return merged;
}

async function apiGet<T>(t: FreeeToken, path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${t.access_token}`, "X-Api-Version": "2020-06-15" } });
  if (!res.ok) throw new Error(`freee ${path}: ${res.status}`);
  return (await res.json()) as T;
}
export type Walletable = { id: number; name: string; type: string; bank_id?: number | null; walletable_balance?: number | null; last_balance?: number | null; last_synced_at?: string | null; sync_status?: string | null; };

export async function listCompanies(env: Env, userId: string) {
  const t = await validToken(env, userId); if (!t) return [];
  const r = await apiGet<{ companies: { id: number; display_name?: string; name?: string }[] }>(t, "/api/1/companies");
  const companies = r.companies.map((c) => ({ id: c.id, name: c.display_name ?? c.name ?? String(c.id) }));
  await saveToken(env, userId, { ...t, companies });
  return companies;
}
export async function listWalletables(env: Env, userId: string, companyId: string) {
  const t = await validToken(env, userId); if (!t) return [];
  const r = await apiGet<{ walletables: Walletable[] }>(t, `/api/1/walletables?company_id=${encodeURIComponent(companyId)}&with_balance=true`);
  return r.walletables;
}

export type SyncResult = { connected: boolean; checked: number; updated: number; stale: number; errors: string[]; synced_at: string | null };
/**
 * Hourly: for each asset_account with source='freee', fetch the company's walletables and
 * record a new asset_balances row (source 'freee') only when the bank sync time is newer than
 * the latest stored freee row. Stale (>2 days) results are counted so the UI can show 参考額.
 * No-op when not connected.
 */
export async function syncFreeeBalances(env: Env, userId: string): Promise<SyncResult> {
  const result: SyncResult = { connected: false, checked: 0, updated: 0, stale: 0, errors: [], synced_at: null };
  if (!freeeConfigured(env)) return result;
  const t = await loadToken(env, userId);
  if (!t) return result;
  result.connected = true;
  const accounts = await all<{ id: string; freee_company_id: string; freee_walletable_id: string; currency: string }>(env.DB,
    "SELECT id, freee_company_id, freee_walletable_id, currency FROM asset_accounts WHERE user_id=? AND source='freee' AND archived_at IS NULL AND freee_company_id IS NOT NULL AND freee_walletable_id IS NOT NULL", userId);
  const byCompany = new Map<string, typeof accounts>();
  for (const a of accounts) byCompany.set(a.freee_company_id, [...(byCompany.get(a.freee_company_id) ?? []), a]);
  const now = new Date().toISOString();
  const todayJst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (const [companyId, accs] of byCompany) {
    let ws: Walletable[];
    try { ws = await listWalletables(env, userId, companyId); }
    catch (e) { result.errors.push(`事業所 ${companyId}: ${(e as Error).message}`); continue; }
    for (const a of accs) {
      result.checked++;
      const w = ws.find((x) => String(x.id) === a.freee_walletable_id);
      if (!w) { result.errors.push(`口座 ${a.freee_walletable_id} がfreeeに見つかりません`); continue; }
      if (w.last_balance == null || !w.last_synced_at) { result.errors.push(`${w.name}: 銀行同期残高が未取得`); continue; }
      const recordedOn = new Date(new Date(w.last_synced_at).getTime() + 9 * 3600e3).toISOString().slice(0, 10);
      if (isStale(recordedOn, todayJst)) result.stale++;
      const latest = await one<{ recorded_on: string; synced_at: string | null }>(env.DB, "SELECT recorded_on, synced_at FROM asset_balances WHERE account_id=? AND source='freee' ORDER BY recorded_on DESC, created_at DESC LIMIT 1", a.id);
      if (latest && latest.recorded_on >= recordedOn) continue; // bank sync date unchanged → no new history row
      await run(env.DB, "INSERT INTO asset_balances (id, account_id, user_id, recorded_on, quantity, rate, rate_date, rate_source, jpy_value, source, synced_at) VALUES (?,?,?,?,?,?,?,?,?,'freee',?)",
        newId(), a.id, userId, recordedOn, w.last_balance, a.currency === "JPY" ? 1 : null, recordedOn, "freee", a.currency === "JPY" ? w.last_balance : null, now);
      result.updated++;
    }
  }
  result.synced_at = now;
  await setSetting(env, userId, "freee_last_sync", { at: now, errors: result.errors, checked: result.checked, updated: result.updated, stale: result.stale });
  return result;
}
export const lastSyncInfo = (env: Env, userId: string) => getSetting<{ at: string; errors: string[]; checked: number; updated: number; stale: number } | null>(env, userId, "freee_last_sync", null);
