import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { WeatherLocation } from "../../shared/types";
import { normalizePushPrefs } from "../../shared/notifications";
import { all, run, one, newId, getSetting, setSetting, kvPutSafe } from "./db";
import { pushConfigured, sendToSubscriptions, userSubscriptions } from "./push";
import { fetchWeather, WEATHER_CODE_LABEL } from "./weather";
import { buildLifeContext, suggestAction } from "./context";

export const coreRoutes = new Hono<AppEnv>();

// ---- Notifications bell ----
coreRoutes.get("/notifications", async (c) => {
  const user = c.get("user");
  const unreadOnly = c.req.query("unread") === "1";
  const rows = await all(c.env.DB, `SELECT id,kind,title,body,url,created_at,read_at FROM notifications WHERE user_id=? ${unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 100`, user.id);
  const unread = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", user.id);
  return c.json({ items: rows, unread: unread?.n ?? 0 });
});
coreRoutes.post("/notifications/read", async (c) => {
  const user = c.get("user");
  const body = z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional(), unread: z.boolean().optional() }).parse(await c.req.json());
  if (body.all) await run(c.env.DB, "UPDATE notifications SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL", user.id);
  else for (const id of body.ids ?? []) await run(c.env.DB, body.unread ? "UPDATE notifications SET read_at=NULL WHERE id=? AND user_id=?" : "UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=?", id, user.id);
  return c.json({ ok: true });
});
/** Test: always records in the bell and pushes to every registered device (ignores the module switches). */
coreRoutes.post("/notifications/test", async (c) => {
  const user = c.get("user");
  const body = z.object({ id: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
  const id = newId();
  const n = { title: "テスト通知", body: "Life OSからのテスト通知です。", url: "/settings#notifications" };
  await run(c.env.DB, "INSERT INTO notifications (id,user_id,kind,title,body,url) VALUES (?,?,?,?,?,?)", id, user.id, "system", n.title, n.body, n.url);
  const results = pushConfigured(c.env) ? await sendToSubscriptions(c.env, await userSubscriptions(c.env, user.id, body.id), { ...n, tag: id }, 600) : [];
  return c.json({ ok: true, pushConfigured: pushConfigured(c.env), results, delivery: { sent: results.filter((r) => r.ok).length } });
});

// ---- Settings ----
coreRoutes.get("/settings", async (c) => {
  const user = c.get("user");
  const rows = await all<{ key: string; value_json: string }>(c.env.DB, "SELECT key,value_json FROM settings WHERE user_id=?", user.id);
  const settings: Record<string, unknown> = {};
  for (const r of rows) { try { settings[r.key] = JSON.parse(r.value_json); } catch { /* ignore */ } }
  settings.push_prefs = normalizePushPrefs(settings.push_prefs, settings.notification_prefs);
  const stored = await all<{ provider: string }>(c.env.DB, "SELECT provider FROM integration_tokens WHERE user_id=?", user.id);
  const has = (p: string) => stored.some((r) => r.provider === p);
  return c.json({ settings, vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null, integrations: {
    google: Boolean(c.env.GOOGLE_CLIENT_ID), oura: Boolean(c.env.OURA_ACCESS_TOKEN) || has("oura"), freee: Boolean(c.env.FREEE_CLIENT_ID), freee_connected: has("freee"), google_calendar: has("google_calendar"), gmail: has("gmail"),
    push: pushConfigured(c.env), backups: Boolean(c.env.BACKUP_INGEST_TOKEN), fx: Boolean(c.env.FX_CONNECTOR_TOKEN),
  } });
});
coreRoutes.put("/settings/:key", async (c) => {
  const user = c.get("user");
  const key = c.req.param("key");
  if (!/^[a-z0-9_]{1,64}$/.test(key)) return c.json({ error: "bad key" }, 400);
  const value = await c.req.json();
  if (key === "notification_prefs") z.record(z.string(), z.object({ push: z.boolean(), discord: z.boolean().optional() })).parse(value);
  if (key === "push_prefs") z.object({ modules: z.record(z.string(), z.boolean()), kinds: z.record(z.string(), z.boolean()) }).parse(value);
  if (key === "weather_location") z.object({ name: z.string(), lat: z.number(), lon: z.number() }).parse(value);
  await setSetting(c.env, user.id, key, value);
  return c.json({ ok: true });
});

// ---- Push subscriptions (one row per browser / installed app) ----
/** VAPID public key, and whether this browser's subscription is still registered with the current key. */
coreRoutes.get("/push/config", async (c) => {
  const user = c.get("user");
  const endpoint = c.req.query("endpoint");
  const row = endpoint ? await one<{ vapid_key: string | null }>(c.env.DB, "SELECT vapid_key FROM push_subscriptions WHERE endpoint=? AND user_id=?", endpoint, user.id) : null;
  return c.json({ publicKey: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null, known: Boolean(row), stale: Boolean(row && row.vapid_key && row.vapid_key !== c.env.VAPID_PUBLIC_KEY) });
});
coreRoutes.get("/push/subscriptions", async (c) => {
  const user = c.get("user");
  const items = await all<{ vapid_key: string | null }>(c.env.DB, "SELECT id,endpoint,user_agent,label,vapid_key,last_ok_at,last_error,created_at FROM push_subscriptions WHERE user_id=? AND enabled=1 ORDER BY created_at DESC", user.id);
  return c.json({ items: items.map(({ vapid_key, ...r }) => ({ ...r, stale: Boolean(vapid_key && vapid_key !== c.env.VAPID_PUBLIC_KEY) })) });
});
const subSchema = z.object({ endpoint: z.string().url().startsWith("https://"), keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(32) }) });
coreRoutes.post("/push/subscribe", async (c) => {
  const user = c.get("user");
  const body = subSchema.extend({ label: z.string().max(60).optional(), replaces: z.string().optional() }).parse(await c.req.json());
  if (body.replaces && body.replaces !== body.endpoint) await run(c.env.DB, "DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?", body.replaces, user.id);
  await run(c.env.DB, "INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,label,enabled,vapid_key) VALUES (?,?,?,?,?,?,?,1,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, enabled=1, user_id=excluded.user_id, user_agent=excluded.user_agent, label=COALESCE(excluded.label, push_subscriptions.label), vapid_key=excluded.vapid_key, last_error=NULL",
    newId(), user.id, body.endpoint, body.keys.p256dh, body.keys.auth, c.req.header("User-Agent")?.slice(0, 300) ?? null, body.label ?? null, c.env.VAPID_PUBLIC_KEY ?? null);
  return c.json({ ok: true });
});
coreRoutes.post("/push/unsubscribe", async (c) => {
  const user = c.get("user");
  const body = z.object({ endpoint: z.string().optional(), id: z.string().optional() }).parse(await c.req.json());
  if (body.id) await run(c.env.DB, "DELETE FROM push_subscriptions WHERE id=? AND user_id=?", body.id, user.id);
  if (body.endpoint) await run(c.env.DB, "DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?", body.endpoint, user.id);
  return c.json({ ok: true });
});

/**
 * Public (no session): the service worker's `pushsubscriptionchange` handler swaps in the browser's new
 * subscription. The old endpoint is an unguessable capability URL, so it identifies the row.
 */
export const pushPublicRoutes = new Hono<AppEnv>();
pushPublicRoutes.get("/config", (c) => c.json({ publicKey: pushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null }));
pushPublicRoutes.post("/rotate", async (c) => {
  const body = z.object({ oldEndpoint: z.string().url(), subscription: subSchema }).parse(await c.req.json());
  const r = await run(c.env.DB, "UPDATE push_subscriptions SET endpoint=?, p256dh=?, auth=?, vapid_key=?, last_error=NULL WHERE endpoint=?", body.subscription.endpoint, body.subscription.keys.p256dh, body.subscription.keys.auth, c.env.VAPID_PUBLIC_KEY ?? null, body.oldEndpoint);
  return c.json({ ok: Boolean(r.meta?.changes) }, r.meta?.changes ? 200 : 404);
});

// ---- Weather ----
coreRoutes.get("/weather", async (c) => {
  const user = c.get("user");
  const loc = await getSetting<WeatherLocation | null>(c.env, user.id, "weather_location", null);
  if (!loc) return c.json({ configured: false });
  const cacheKey = `weather:${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  const cached = await c.env.KV.get(cacheKey, "json");
  if (cached) return c.json({ configured: true, ...(cached as object), cached: true });
  try {
    const w = await fetchWeather(loc);
    const out = { ...w, weather_label: w.weather_code != null ? (WEATHER_CODE_LABEL[w.weather_code] ?? "—") : null };
    await kvPutSafe(c.env, cacheKey, JSON.stringify(out), { expirationTtl: 600 });
    return c.json({ configured: true, ...out });
  } catch (e) { return c.json({ configured: true, error: String(e) }, 502); }
});
coreRoutes.get("/weather/geocode", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) return c.json({ items: [] });
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", q); url.searchParams.set("count", "8"); url.searchParams.set("language", "ja"); url.searchParams.set("country", "JP");
  const r = await fetch(url.toString()); const j = (await r.json()) as any;
  return c.json({ items: (j.results ?? []).map((x: any) => ({ name: [x.name, x.admin1].filter(Boolean).join(" / "), lat: x.latitude, lon: x.longitude })) });
});

// ---- Life context & advice ----
coreRoutes.get("/context", async (c) => {
  const user = c.get("user");
  const ctx = await buildLifeContext(c.env, user.id, { weather: c.req.query("weather") === "1" });
  return c.json({ context: ctx, suggestion: suggestAction(ctx) });
});
