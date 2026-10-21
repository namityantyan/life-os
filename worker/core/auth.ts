import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import type { User } from "../../shared/types";
import { one, run, newId } from "./db";

const SESSION_COOKIE = "lifeos_session";
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

function allowedEmails(env: Env): string[] {
  return (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const sid = newId() + newId().replace(/-/g, "");
  // Sessions live in D1: KV's free tier allows only 1,000 writes/day.
  await run(env.DB, "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", sid, userId, new Date(Date.now() + SESSION_TTL * 1000).toISOString());
  const sig = await hmac(env.SESSION_SECRET, sid);
  return `${sid}.${sig}`;
}

export async function readSession(env: Env, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [sid, sig] = token.split(".");
  if (!sid || !sig) return null;
  if ((await hmac(env.SESSION_SECRET, sid)) !== sig) return null;
  const row = await one<{ user_id: string; expires_at: string }>(env.DB, "SELECT user_id, expires_at FROM sessions WHERE id=?", sid);
  if (row) return Date.parse(row.expires_at) > Date.now() ? row.user_id : null;
  // Sessions created before the move to D1 are still honoured until they expire.
  try { const raw = await env.KV.get(`session:${sid}`); return raw ? (JSON.parse(raw) as { userId: string }).userId : null; } catch { return null; }
}

/** OAuth `state` without storage: nonce.timestamp.signature, with the nonce also kept in a short-lived cookie. */
export async function signedState(env: Env, payload = ""): Promise<{ state: string; nonce: string }> {
  const nonce = newId().replace(/-/g, "");
  const body = `${nonce}.${Date.now()}.${btoa(payload).replace(/=+$/, "")}`;
  return { state: `${body}.${await hmac(env.SESSION_SECRET, body)}`, nonce };
}
export async function verifyState(env: Env, state: string | undefined, nonceCookie: string | undefined, maxAgeMs = 10 * 60 * 1000): Promise<string | null> {
  if (!state || !nonceCookie) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [nonce, ts, p64, sig] = parts as [string, string, string, string];
  if (nonce !== nonceCookie) return null;
  if ((await hmac(env.SESSION_SECRET, `${nonce}.${ts}.${p64}`)) !== sig) return null;
  if (!(Date.now() - Number(ts) < maxAgeMs)) return null;
  try { return atob(p64); } catch { return null; }
}

export async function upsertUser(env: Env, profile: { email: string; name?: string | null; picture?: string | null }): Promise<User> {
  const email = profile.email.toLowerCase();
  const existing = await one<User>(env.DB, "SELECT id,email,name,picture FROM users WHERE email=?", email);
  if (existing) {
    await run(env.DB, "UPDATE users SET name=COALESCE(?,name), picture=COALESCE(?,picture), last_login_at=datetime('now') WHERE id=?", profile.name ?? null, profile.picture ?? null, existing.id);
    return { ...existing, name: profile.name ?? existing.name, picture: profile.picture ?? existing.picture };
  }
  const id = newId();
  await run(env.DB, "INSERT INTO users (id,email,name,picture,last_login_at) VALUES (?,?,?,?,datetime('now'))", id, email, profile.name ?? null, profile.picture ?? null);
  return { id, email, name: profile.name ?? null, picture: profile.picture ?? null };
}

function setSessionCookie(c: any, token: string) {
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "Lax", secure, maxAge: SESSION_TTL });
}

/** Requires an authenticated session; also enforces same-site origin on mutating requests. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("Origin") ?? c.req.header("Referer");
    const self = new URL(c.req.url).origin;
    if (origin && !origin.startsWith(self) && !origin.startsWith(c.env.APP_ORIGIN)) {
      return c.json({ error: "cross-site request rejected" }, 403);
    }
    const sfs = c.req.header("Sec-Fetch-Site");
    if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
      return c.json({ error: "cross-site request rejected" }, 403);
    }
  }
  const userId = await readSession(c.env, getCookie(c, SESSION_COOKIE));
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const user = await one<User>(c.env.DB, "SELECT id,email,name,picture FROM users WHERE id=?", userId);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/me", async (c) => {
  const userId = await readSession(c.env, getCookie(c, SESSION_COOKIE));
  if (!userId) return c.json({ user: null, googleConfigured: Boolean(c.env.GOOGLE_CLIENT_ID), devLogin: c.env.DEV_LOGIN === "1" });
  const user = await one<User>(c.env.DB, "SELECT id,email,name,picture FROM users WHERE id=?", userId);
  return c.json({ user, googleConfigured: Boolean(c.env.GOOGLE_CLIENT_ID), devLogin: c.env.DEV_LOGIN === "1" });
});

authRoutes.get("/google/start", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "Google OAuth is not configured (GOOGLE_CLIENT_ID)" }, 503);
  const { state, nonce } = await signedState(c.env);
  setCookie(c, "lifeos_oauth", nonce, { path: "/api/auth", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 });
  const redirect = `${new URL(c.req.url).origin}/api/auth/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
});

authRoutes.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || (await verifyState(c.env, state, getCookie(c, "lifeos_oauth"))) === null) return c.text("invalid oauth state", 400);
  deleteCookie(c, "lifeos_oauth", { path: "/api/auth" });
  const redirect = `${new URL(c.req.url).origin}/api/auth/google/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: c.env.GOOGLE_CLIENT_ID!, client_secret: c.env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirect, grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("token exchange failed", 502);
  const tok = (await tokenRes.json()) as { access_token: string };
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!infoRes.ok) return c.text("userinfo failed", 502);
  const info = (await infoRes.json()) as { email: string; email_verified?: boolean; name?: string; picture?: string };
  if (!info.email || !allowedEmails(c.env).includes(info.email.toLowerCase())) {
    return c.redirect("/login?error=not_allowed");
  }
  const user = await upsertUser(c.env, { email: info.email, name: info.name ?? null, picture: info.picture ?? null });
  setSessionCookie(c, await createSession(c.env, user.id));
  return c.redirect("/");
});

/** Local-development login. Only enabled when DEV_LOGIN=1 (never set it in production). */
authRoutes.post("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "1") return c.json({ error: "disabled" }, 404);
  const email = allowedEmails(c.env)[0] ?? "dev@example.com";
  const user = await upsertUser(c.env, { email, name: "Dev User" });
  setSessionCookie(c, await createSession(c.env, user.id));
  return c.json({ user });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const sid = token.split(".")[0];
    await run(c.env.DB, "DELETE FROM sessions WHERE id=?", sid);
    try { await c.env.KV.delete(`session:${sid}`); } catch { /* legacy session store */ }
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
