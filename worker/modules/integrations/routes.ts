// 外部サービス接続: Google (Calendar / Gmail, read-only OAuth), Oura (personal access token), status of all providers.
// Tokens are stored encrypted in integration_tokens via the shared helpers in assets/freee.ts.
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { signedState, verifyState } from "../../core/auth";
import { loadToken, saveToken, deleteToken } from "../assets/freee";
import { syncOura } from "../health/oura";
import { buildGoogleToken, GOOGLE_PROVIDERS, parseRequestedScopes, providersForGrantedScopes, scopeParam, shapeStatus, type GoogleScopeKey, type GoogleTokenResponse, type StoredGoogleToken } from "./logic";

export const routes = new Hono<AppEnv>();

const STATE_TTL = 600; // 10 min
const redirectUri = (origin: string) => `${origin}/api/integrations/google/callback`;
const settingsUrl = (result: string) => `/settings?connected=${result}#integrations`;

async function load<T>(env: Env, userId: string, provider: string): Promise<T | null> {
  return (await loadToken(env, userId, provider)) as unknown as T | null;
}

/* ---------- status ---------- */
routes.get("/status", async (c) => {
  const user = c.get("user");
  const [google_calendar, gmail, oura, freee] = await Promise.all([
    load<StoredGoogleToken>(c.env, user.id, "google_calendar"),
    load<StoredGoogleToken>(c.env, user.id, "gmail"),
    load<{ access_token: string; connected_at?: string }>(c.env, user.id, "oura"),
    loadToken(c.env, user.id, "freee"),
  ]);
  return c.json(shapeStatus({
    tokens: { google_calendar, gmail, oura, freee },
    env: { googleClientId: c.env.GOOGLE_CLIENT_ID, ouraAccessToken: c.env.OURA_ACCESS_TOKEN, freeeClientId: c.env.FREEE_CLIENT_ID },
  }));
});

/* ---------- Google OAuth (offline, consent → refresh_token) ---------- */
routes.get("/google/start", async (c) => {
  const user = c.get("user");
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "Google OAuth is not configured (GOOGLE_CLIENT_ID)" }, 503);
  const scopes = parseRequestedScopes(c.req.query("scopes"));
  const { state, nonce } = await signedState(c.env, JSON.stringify({ userId: user.id, scopes }));
  setCookie(c, "lifeos_oauth_int", nonce, { path: "/api/integrations", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: STATE_TTL });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(new URL(c.req.url).origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopeParam(scopes));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return c.redirect(url.toString());
});

routes.get("/google/callback", async (c) => {
  const user = c.get("user");
  const code = c.req.query("code");
  const state = c.req.query("state");
  const raw = await verifyState(c.env, state, getCookie(c, "lifeos_oauth_int"), STATE_TTL * 1000);
  if (raw === null) return c.text("invalid oauth state", 400);
  deleteCookie(c, "lifeos_oauth_int", { path: "/api/integrations" });
  let bound: { userId: string; scopes: GoogleScopeKey[] };
  try { bound = JSON.parse(raw); } catch { return c.text("invalid oauth state", 400); }
  if (bound.userId !== user.id) return c.text("oauth state does not belong to this user", 403);
  if (c.req.query("error") || !code) return c.redirect(settingsUrl("google_denied"));

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID ?? "", client_secret: c.env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(new URL(c.req.url).origin), grant_type: "authorization_code" }),
  });
  if (!tokenRes.ok) return c.redirect(settingsUrl("google_error"));
  const tok = (await tokenRes.json()) as GoogleTokenResponse;
  const providers = providersForGrantedScopes(tok.scope);
  if (!tok.access_token || providers.length === 0) return c.redirect(settingsUrl("google_noscope"));

  // Google omits refresh_token when consent was previously granted; keep an existing one for either provider.
  const previous = (await load<StoredGoogleToken>(c.env, user.id, "google_calendar")) ?? (await load<StoredGoogleToken>(c.env, user.id, "gmail"));
  const stored = buildGoogleToken(tok, previous);
  for (const p of providers) await saveToken(c.env, user.id, stored, p);
  return c.redirect(settingsUrl("google"));
});

routes.delete("/google", async (c) => {
  const user = c.get("user");
  const tokens = await Promise.all(GOOGLE_PROVIDERS.map((p) => load<StoredGoogleToken>(c.env, user.id, p)));
  const t = tokens.find(Boolean);
  if (t) {
    const revoke = t.refresh_token ?? t.access_token;
    try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revoke)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }); }
    catch { /* revoke is best-effort; the local copy is deleted regardless */ }
  }
  for (const p of GOOGLE_PROVIDERS) await deleteToken(c.env, user.id, p);
  return c.json({ ok: true });
});

/* ---------- Oura (personal access token) ---------- */
routes.post("/oura", async (c) => {
  const user = c.get("user");
  const parsed = z.object({ token: z.string().trim().min(8) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "トークンを入力してください" }, 400);
  const token = parsed.data.token;
  let res: Response;
  try { res = await fetch("https://api.ouraring.com/v2/usercollection/personal_info", { headers: { Authorization: `Bearer ${token}` } }); }
  catch { return c.json({ error: "Oura APIに接続できませんでした" }, 502); }
  if (!res.ok) return c.json({ error: res.status === 401 || res.status === 403 ? "Ouraのトークンが無効です" : `Oura API エラー (${res.status})` }, 400);
  const info = (await res.json().catch(() => ({}))) as { email?: string; id?: string };
  await saveToken(c.env, user.id, { access_token: token, connected_at: new Date().toISOString(), email: info.email ?? null }, "oura");
  return c.json({ ok: true, email: info.email ?? null });
});

routes.delete("/oura", async (c) => {
  const user = c.get("user");
  await deleteToken(c.env, user.id, "oura");
  return c.json({ ok: true });
});

routes.post("/oura/sync", async (c) => {
  const user = c.get("user");
  try { return c.json({ ok: true, ...(await syncOura(c.env, user.id)) }); }
  catch (e) { return c.json({ ok: false, error: String((e as Error)?.message ?? e) }, 502); }
});
