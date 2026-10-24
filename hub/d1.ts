// Minimal D1-compatible wrapper over node:sqlite so the Worker's FX module runs unchanged in the hub.
import { DatabaseSync, type StatementSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param));
const plain = <T>(row: unknown): T => (row && typeof row === "object" ? { ...(row as object) } : row) as T;

class Statement {
  constructor(private shim: D1Shim, readonly sql: string, readonly params: Param[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.shim, this.sql, params.map(norm)); }
  private get stmt() { return this.shim.stmt(this.sql); }
  async all<T = Record<string, unknown>>() {
    return { results: this.stmt.all(...this.params).map((r) => plain<T>(r)), success: true, meta: {} };
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? (row[col] as T) : plain<T>(row)) ?? null;
  }
  async run() {
    const r = this.stmt.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  /** used by batch() inside a transaction */
  runSync() { return this.stmt.run(...this.params); }
}

export class D1Shim {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  }
  /** Compiled statements are reused (node:sqlite resets them per call; SQLite re-prepares after schema changes). */
  private cache = new Map<string, StatementSync>();
  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value as string); this.cache.set(sql, s); }
    return s;
  }
  prepare(sql: string) { return new Statement(this, sql); }
  /** Refreshes query-planner statistics where useful (cheap; run at startup and daily). */
  optimize() { try { this.db.exec("PRAGMA optimize=0x10002"); } catch (e) { console.warn("PRAGMA optimize failed", String(e)); } }
  async batch(stmts: Statement[]) {
    this.db.exec("BEGIN");
    try { const out = stmts.map((s) => s.runSync()); this.db.exec("COMMIT"); return out.map((r) => ({ success: true, meta: { changes: Number(r.changes) } })); }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 0, duration: 0 }; }
}

/** Applies migrations/*.sql once each, in order (same files the Worker's D1 uses). */
export function migrate(shim: D1Shim, files: { name: string; sql: string }[]) {
  shim.db.exec("CREATE TABLE IF NOT EXISTS _hub_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const done = new Set((shim.db.prepare("SELECT name FROM _hub_migrations").all() as { name: string }[]).map((r) => r.name));
  for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(f.name)) continue;
    shim.db.exec("BEGIN");
    try { shim.db.exec(f.sql); shim.db.prepare("INSERT INTO _hub_migrations (name) VALUES (?)").run(f.name); shim.db.exec("COMMIT"); }
    catch (e) { shim.db.exec("ROLLBACK"); throw new Error(`migration ${f.name} failed: ${String(e)}`); }
  }
}
