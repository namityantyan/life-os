// Minimal D1-compatible wrapper over node:sqlite so the Worker's FX module runs unchanged in the hub.
import { DatabaseSync } from "node:sqlite";

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param));
const plain = <T>(row: unknown): T => (row && typeof row === "object" ? { ...(row as object) } : row) as T;

class Statement {
  constructor(private db: DatabaseSync, readonly sql: string, readonly params: Param[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.db, this.sql, params.map(norm)); }
  async all<T = Record<string, unknown>>() {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => plain<T>(r)), success: true, meta: {} };
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? (row[col] as T) : plain<T>(row)) ?? null;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  /** used by batch() inside a transaction */
  runSync() { return this.db.prepare(this.sql).run(...this.params); }
}

export class D1Shim {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  }
  prepare(sql: string) { return new Statement(this.db, sql); }
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
