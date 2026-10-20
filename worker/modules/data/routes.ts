import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one } from "../../core/db";

/**
 * Data module: whole-account export / import and storage stats.
 *
 * Every table listed here is keyed by `user_id`. Sessions live in KV and
 * `integration_tokens` / `push_subscriptions` / `notification_queue` hold
 * secrets or transient delivery state, so they are deliberately left out.
 * Column lists are read from the live schema (PRAGMA table_info) so later
 * migrations that add columns are picked up automatically.
 */
export const EXPORT_VERSION = 1;
export const EXPORT_TABLES = [
  "settings", "notifications",
  "planner_items", "ideas", "notes",
  "oura_daily", "meal_routines", "beauty_routines", "checkups", "pressure_logs", "chat_messages",
  "training_sessions", "training_sets",
  "asset_accounts", "asset_balances", "card_transactions", "card_statements",
  "fx_connector_state", "fx_signals", "fx_trades", "fx_trade_events",
  "invoices", "royalty_mails", "backup_runs", "requests",
  "discord_links", "discord_channels",
] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];
const TABLE_SET = new Set<string>(EXPORT_TABLES);

type ColInfo = { name: string; pk: number };
const colCache = new Map<string, ColInfo[]>();
async function columns(db: D1Database, table: ExportTable): Promise<ColInfo[]> {
  const hit = colCache.get(table);
  if (hit) return hit;
  const rows = await all<{ name: string; pk: number }>(db, `PRAGMA table_info("${table}")`);
  const cols = rows.map((r) => ({ name: r.name, pk: r.pk }));
  colCache.set(table, cols);
  return cols;
}

/** Coerce an imported JSON value into something D1 accepts. */
function toSqlValue(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return JSON.stringify(v);
}

export const routes = new Hono<AppEnv>();

routes.get("/", (c) => c.json({ module: "data", version: EXPORT_VERSION, tables: EXPORT_TABLES }));

/* ---------- Export ---------- */
routes.get("/export", async (c) => {
  const user = c.get("user");
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const t of EXPORT_TABLES) {
    tables[t] = await all(c.env.DB, `SELECT * FROM "${t}" WHERE user_id=?`, user.id);
  }
  c.header("Content-Disposition", `attachment; filename="life-os-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({ version: EXPORT_VERSION, exported_at: new Date().toISOString(), user: { email: user.email }, tables });
});

const NOTE_CATEGORIES = ["policy", "decision", "promise", "preference", "other"] as const;
const CATEGORY_LABELS: Record<string, string> = { policy: "方針", decision: "決定", promise: "約束", preference: "好み", other: "その他" };
export function notesToMarkdown(notes: { category: string; content: string; created_at: string }[], exportedAt = new Date().toISOString()): string {
  const lines: string[] = ["---", "title: Life OS メモ", `exported: ${exportedAt}`, "source: life-os", "---", "", "# メモ", ""];
  const cats = [...NOTE_CATEGORIES, ...Array.from(new Set(notes.map((n) => n.category))).filter((c) => !(NOTE_CATEGORIES as readonly string[]).includes(c))];
  for (const cat of cats) {
    const items = notes.filter((n) => n.category === cat);
    if (items.length === 0) continue;
    lines.push(`## ${CATEGORY_LABELS[cat] ?? cat}`, "");
    for (const n of items) {
      const [first, ...rest] = n.content.split(/\r?\n/);
      lines.push(`- ${n.created_at.slice(0, 10)} — ${first}`);
      for (const l of rest) lines.push(`  ${l}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

routes.get("/export/notes.md", async (c) => {
  const user = c.get("user");
  const notes = await all<{ category: string; content: string; created_at: string }>(c.env.DB, "SELECT category,content,created_at FROM notes WHERE user_id=? AND archived_at IS NULL ORDER BY created_at", user.id);
  c.header("Content-Type", "text/markdown; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="life-os-notes-${new Date().toISOString().slice(0, 10)}.md"`);
  return c.body(notesToMarkdown(notes));
});

/* ---------- Stats ---------- */
routes.get("/stats", async (c) => {
  const user = c.get("user");
  const counts: Record<string, number> = {};
  let bytes = 0;
  for (const t of EXPORT_TABLES) {
    const cols = await columns(c.env.DB, t);
    const sizeExpr = cols.map((col) => `COALESCE(LENGTH(CAST("${col.name}" AS TEXT)),0)`).join("+");
    const row = await one<{ n: number; bytes: number | null }>(c.env.DB, `SELECT COUNT(*) AS n, SUM(${sizeExpr}) AS bytes FROM "${t}" WHERE user_id=?`, user.id);
    counts[t] = row?.n ?? 0;
    bytes += row?.bytes ?? 0;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return c.json({ counts, total, size_bytes_estimate: bytes, tables: EXPORT_TABLES });
});

/* ---------- Import ---------- */
const rowSchema = z.record(z.string(), z.unknown());
const importSchema = z.object({
  mode: z.enum(["merge", "replace"]),
  data: z.union([
    z.object({ version: z.number().optional(), tables: z.record(z.string(), z.array(rowSchema)) }),
    z.record(z.string(), z.array(rowSchema)),
  ]),
});

routes.post("/import", async (c) => {
  const user = c.get("user");
  const parsed = importSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", detail: parsed.error.issues }, 400);
  const { mode } = parsed.data;
  const raw = parsed.data.data;
  const tables: Record<string, Record<string, unknown>[]> = "tables" in raw && raw.tables && typeof raw.tables === "object" && !Array.isArray(raw.tables)
    ? (raw.tables as Record<string, Record<string, unknown>[]>)
    : (raw as Record<string, Record<string, unknown>[]>);

  const skipped: string[] = [];
  const inserted: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  const db = c.env.DB;
  const BATCH = 50;

  for (const [name, rows] of Object.entries(tables)) {
    if (!TABLE_SET.has(name)) { skipped.push(name); continue; }
    const table = name as ExportTable;
    const cols = await columns(db, table);
    const colNames = new Set(cols.map((x) => x.name));

    if (mode === "replace") {
      const r = await db.prepare(`DELETE FROM "${table}" WHERE user_id=?`).bind(user.id).run();
      deleted[table] = r.meta?.changes ?? 0;
    }

    let n = 0;
    const stmts: D1PreparedStatement[] = [];
    for (const row of rows) {
      const keys = Object.keys(row).filter((k) => colNames.has(k) && k !== "user_id");
      if (keys.length === 0) continue;
      const names = ["user_id", ...keys].map((k) => `"${k}"`).join(",");
      const marks = ["?", ...keys.map(() => "?")].join(",");
      const vals = [user.id, ...keys.map((k) => toSqlValue(row[k]))];
      stmts.push(db.prepare(`INSERT OR IGNORE INTO "${table}" (${names}) VALUES (${marks})`).bind(...vals));
      if (stmts.length >= BATCH) { n += (await db.batch(stmts)).reduce((a, r) => a + (r.meta?.changes ?? 0), 0); stmts.length = 0; }
    }
    if (stmts.length) n += (await db.batch(stmts)).reduce((a, r) => a + (r.meta?.changes ?? 0), 0);
    inserted[table] = n;
  }
  return c.json({ ok: true, mode, inserted, deleted, skipped, total: Object.values(inserted).reduce((a, b) => a + b, 0) });
});
