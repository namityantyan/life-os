// Node replacements for the Cloudflare bindings used by the Worker app.
import type { D1Shim } from "../hub/d1";

/** KV over SQLite (table _kv) with TTL semantics close to Workers KV. */
export class KvShim {
  constructor(private db: D1Shim) {
    db.db.exec("CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  }
  async get(key: string, type?: "text" | "json" | { type: "text" | "json" }) {
    const t = typeof type === "object" ? type.type : type;
    const row = this.db.db.prepare("SELECT value, expires_at FROM _kv WHERE key=?").get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) { this.db.db.prepare("DELETE FROM _kv WHERE key=?").run(key); return null; }
    return t === "json" ? JSON.parse(row.value) : row.value;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
    const exp = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts?.expiration ? opts.expiration * 1000 : null;
    this.db.db.prepare("INSERT INTO _kv (key, value, expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at").run(key, value, exp);
  }
  async delete(key: string) { this.db.db.prepare("DELETE FROM _kv WHERE key=?").run(key); }
  async list(opts?: { prefix?: string }) {
    const rows = this.db.db.prepare("SELECT key FROM _kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)").all(`${opts?.prefix ?? ""}%`, Date.now()) as { key: string }[];
    return { keys: rows.map((r) => ({ name: r.key })), list_complete: true, cursor: "" };
  }
  sweep() { this.db.db.prepare("DELETE FROM _kv WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now()); }
}

/** Workers AI through the Cloudflare relay Worker (POST /api/internal/ai). Same `run(model, input)` shape. */
export function aiRelay(url: string | undefined, secret: string | undefined) {
  if (!url || !secret) return undefined;
  return {
    async run(model: string, input: unknown) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Secret": secret }, body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`AI relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json();
    },
  };
}

/** Minimal 5-field cron matcher for the schedules used in wrangler.jsonc ("*", "*\/n", numbers, lists). */
export function cronMatches(expr: string, d: Date): boolean {
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const f = (field: string, v: number) => field.split(",").some((part) => {
    if (part === "*") return true;
    const step = part.match(/^\*\/(\d+)$/); if (step) return v % Number(step[1]) === 0;
    return Number(part) === v;
  });
  return f(mi, d.getUTCMinutes()) && f(h, d.getUTCHours()) && f(dom, d.getUTCDate()) && f(mon, d.getUTCMonth() + 1) && f(dow, d.getUTCDay());
}
