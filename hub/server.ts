// Life OS FX hub: runs the Worker's FX module on a small always-on server (SQLite, no request/write quotas).
//   connector (Windows)  → https://<hub>/api/integrations/fx/*   (bearer FX_CONNECTOR_TOKEN)
//   Life OS Worker       → https://<hub>/api/fx/*                (X-Hub-Secret + X-Lifeos-User)
//   hub → Worker         → POST <FX_HUB_NOTIFY_URL>              (trade notifications, outbox with retry)
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AppEnv, Env } from "../worker/env";
import { publicRoutes, routes, flushHubOutbox } from "../worker/modules/fx/routes";
import { D1Shim, migrate } from "./d1";

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v; };
const DATA_DIR = resolve(process.env.FX_HUB_DATA_DIR ?? "./data");
mkdirSync(DATA_DIR, { recursive: true });
const MIGRATIONS_DIR = resolve(process.env.FX_HUB_MIGRATIONS_DIR ?? "./migrations");

const db = new D1Shim(join(DATA_DIR, "fx-hub.sqlite"));
migrate(db, readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") })));

const kvUnavailable = new Proxy({}, { get: () => () => { throw new Error("KV is not available in the FX hub"); } });
const env = {
  DB: db, KV: kvUnavailable, ASSETS: undefined,
  APP_NAME: "Life OS FX hub", APP_ORIGIN: need("FX_HUB_PUBLIC_URL"), ALLOWED_EMAILS: "", SESSION_SECRET: "unused",
  FX_CONNECTOR_TOKEN: need("FX_CONNECTOR_TOKEN"), FX_HUB_SECRET: need("FX_HUB_SECRET"),
  FX_HUB_OWNER_ID: need("FX_HUB_OWNER_ID"), FX_HUB_NOTIFY_URL: need("FX_HUB_NOTIFY_URL"), IS_FX_HUB: "1",
} as unknown as Env;

const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

const app = new Hono<AppEnv>();
app.onError((err, c) => {
  const zod = (err as { name?: string })?.name === "ZodError";
  if (!zod) console.error(err);
  return c.json({ error: zod ? "invalid input" : "internal error", detail: String((err as Error)?.message ?? err) }, zod ? 400 : 500);
});
app.get("/health", (c) => c.json({ ok: true, app: "life-os-fx-hub", time: new Date().toISOString() }));
app.route("/api/integrations/fx", publicRoutes);
app.use("/api/fx/*", async (c, next) => {
  if (!safeEq(c.req.header("X-Hub-Secret") ?? "", env.FX_HUB_SECRET!)) return c.json({ error: "unauthorized" }, 401);
  const uid = c.req.header("X-Lifeos-User") ?? env.FX_HUB_OWNER_ID!;
  if (uid !== env.FX_HUB_OWNER_ID) return c.json({ error: "forbidden" }, 403);
  c.set("user", { id: uid, email: "", name: null, picture: null });
  await next();
});
app.route("/api/fx", routes);
app.all("*", (c) => c.json({ error: "not found" }, 404));

const port = Number(process.env.FX_HUB_PORT ?? 8787);
const host = process.env.FX_HUB_BIND ?? "127.0.0.1";
serve({ fetch: (req) => app.fetch(req, env, { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext), port, hostname: host });
console.log(`life-os-fx-hub listening on http://${host}:${port}`);

// Deliver pending trade notifications every 30 s (and right after each enqueue).
setInterval(() => { flushHubOutbox(env).catch((e) => console.warn("outbox", e)); }, 30_000);
