// Life OS self-hosted server: the Cloudflare Worker app (worker/index.ts) on Node + SQLite.
//   https://dashboard.nami-tool.com → nginx → 127.0.0.1:8791 (this process, PM2 "lifeos")
// Bindings: DB = SQLite (D1 shim), KV = SQLite table, AI = Workers AI via the relay Worker, ASSETS = dist/client.
import { readdirSync, readFileSync, mkdirSync, readdirSync as ls, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import worker from "../worker/index";
import { runScheduled } from "../worker/cron";
import type { Env } from "../worker/env";
import { D1Shim, migrate } from "../hub/d1";
import { KvShim, aiRelay, cronMatches } from "./shims";
import { staticFiles, compressResponse } from "./http";

const ROOT = resolve(process.env.LIFEOS_ROOT ?? ".");
const DATA = resolve(process.env.LIFEOS_DATA_DIR ?? join(ROOT, "data"));
const CLIENT = resolve(process.env.LIFEOS_CLIENT_DIR ?? join(ROOT, "client"));
const MIGRATIONS = resolve(process.env.LIFEOS_MIGRATIONS_DIR ?? join(ROOT, "migrations"));
mkdirSync(join(DATA, "backups"), { recursive: true });

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v; };
const db = new D1Shim(join(DATA, "lifeos.sqlite"));
migrate(db, readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") })));
const kv = new KvShim(db);
db.optimize();

/** Static assets with SPA fallback, cached in memory with ETag and (pre)compressed — see ./http. */
const assets = staticFiles(CLIENT);

const env = {
  DB: db, KV: kv, ASSETS: assets, AI: aiRelay(process.env.AI_RELAY_URL, process.env.AI_RELAY_SECRET),
  APP_NAME: "Life OS", APP_ORIGIN: need("APP_ORIGIN"), ALLOWED_EMAILS: need("ALLOWED_EMAILS"), SESSION_SECRET: need("SESSION_SECRET"),
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(GOOGLE_|VAPID_|DISCORD_|OURA_|FREEE_|BACKUP_|FX_CONNECTOR_TOKEN$|AI_RELAY_|DEV_LOGIN$)/.test(k))),
} as unknown as Env;

const pending = new Set<Promise<unknown>>();
const ctx = { waitUntil(p: Promise<unknown>) { const q = Promise.resolve(p).catch((e) => console.error("waitUntil", e)).finally(() => pending.delete(q)); pending.add(q); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

const isApi = (p: string) => p === "/api" || p.startsWith("/api/");
serve({
  port: Number(process.env.PORT ?? 8791), hostname: process.env.BIND ?? "127.0.0.1",
  fetch: async (req) => { const p = new URL(req.url).pathname; return isApi(p) ? compressResponse(await worker.fetch(req, env, ctx), req.headers.get("Accept-Encoding")) : assets.fetch(req); },
});
console.log(`lifeos listening on ${process.env.BIND ?? "127.0.0.1"}:${process.env.PORT ?? 8791}`);

// Cron triggers from wrangler.jsonc, evaluated every minute (UTC), plus KV TTL sweep and a daily SQLite backup.
const CRONS = ["*/10 * * * *", "0 * * * *", "0 22 * * *"];
let lastMinute = -1;
setInterval(() => {
  const now = new Date(); const m = Math.floor(now.getTime() / 60000);
  if (m === lastMinute) return; lastMinute = m;
  for (const cron of CRONS) if (cronMatches(cron, now)) ctx.waitUntil(runScheduled(env, cron));
  if (now.getUTCMinutes() === 0) kv.sweep();
  if (now.getUTCHours() === 18 && now.getUTCMinutes() === 30) { backup(); db.optimize(); } // 03:30 JST
}, 5_000);

function backup() {
  const name = `lifeos-${new Date().toISOString().slice(0, 10)}.sqlite`;
  try {
    db.db.exec(`VACUUM INTO '${join(DATA, "backups", name).replace(/'/g, "''")}'`);
    const files = ls(join(DATA, "backups")).filter((f) => f.startsWith("lifeos-")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) rmSync(join(DATA, "backups", f));
    console.log("backup written", name);
  } catch (e) { console.error("backup failed", e); }
}
if (process.argv.includes("--backup-now")) backup();
