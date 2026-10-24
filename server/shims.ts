// Node replacements for the Cloudflare bindings used by the Worker app.
import type { D1Shim } from "../hub/d1";

/** KV over SQLite (table _kv) with TTL semantics close to Workers KV. */
export class KvShim {
  constructor(private db: D1Shim) {
    db.db.exec("CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  }
  async get(key: string, type?: "text" | "json" | { type: "text" | "json" }) {
    const t = typeof type === "object" ? type.type : type;
    const row = this.db.stmt("SELECT value, expires_at FROM _kv WHERE key=?").get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) { this.db.stmt("DELETE FROM _kv WHERE key=?").run(key); return null; }
    return t === "json" ? JSON.parse(row.value) : row.value;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
    const exp = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts?.expiration ? opts.expiration * 1000 : null;
    this.db.stmt("INSERT INTO _kv (key, value, expires_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at").run(key, value, exp);
  }
  async delete(key: string) { this.db.stmt("DELETE FROM _kv WHERE key=?").run(key); }
  async list(opts?: { prefix?: string }) {
    const rows = this.db.stmt("SELECT key FROM _kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)").all(`${opts?.prefix ?? ""}%`, Date.now()) as { key: string }[];
    return { keys: rows.map((r) => ({ name: r.key })), list_complete: true, cursor: "" };
  }
  sweep() { this.db.stmt("DELETE FROM _kv WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now()); }
}

/**
 * Workers AI through the Cloudflare relay Worker (POST /api/internal/ai). Same `run(model, input)` shape.
 * A long prompt (chat history + the whole routine) takes ~15 s, and a chat turn makes two calls, so the
 * limit is generous; one retry covers a cold start or a dropped connection.
 */
export function aiRelay(url: string | undefined, secret: string | undefined) {
  if (!url || !secret) return undefined;
  return {
    /** `opts.timeoutMs` / `opts.retry: false` for quick optional calls (dashboard hint); defaults stay 110 s + one retry. */
    async run(model: string, input: unknown, opts: { timeoutMs?: number; retry?: boolean } = {}) {
      let lastErr: unknown;
      const attempts = opts.retry === false ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Secret": secret }, body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(opts.timeoutMs ?? 110_000) });
          if (res.status >= 500 || res.status === 429) throw new Error(`AI relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
          if (!res.ok) throw Object.assign(new Error(`AI relay ${res.status}: ${(await res.text()).slice(0, 200)}`), { noRetry: true });
          return await res.json();
        } catch (e) {
          lastErr = e;
          if ((e as { noRetry?: boolean })?.noRetry || attempt === attempts - 1) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      throw lastErr;
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
