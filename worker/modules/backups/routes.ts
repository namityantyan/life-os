import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, jstDate } from "../../core/db";
import { notify } from "../../core/notify";
import { isStale, hoursSince, normalizeRun, MAX_RUNS_PER_USER, PAGE_SIZE, STALE_HOURS, VERDICT_LABELS, formatDuration, type Verdict } from "./logic";

type RunRow = { id: string; user_id: string; run_id: string; started_at: string | null; finished_at: string | null; duration_sec: number | null; personal_count: number | null; team_count: number | null; personal_bytes: number | null; team_bytes: number | null; errors: number; verdict: Verdict | null; content_json: string; received_at: string };

const toRun = (r: RunRow) => {
  let content: unknown = null; try { content = JSON.parse(r.content_json); } catch { content = r.content_json; }
  const c = (content && typeof content === "object" ? content : {}) as Record<string, unknown>;
  const summary = typeof content === "string" ? content : (typeof c.summary === "string" ? c.summary : typeof c.text === "string" ? c.text : null);
  const error_details = Array.isArray(c.errors) ? c.errors.map(String) : Array.isArray(c.error_details) ? c.error_details.map(String) : [];
  const { content_json: _cj, user_id: _u, ...rest } = r;
  return { ...rest, verdict: (r.verdict ?? "unknown") as Verdict, verdict_label: VERDICT_LABELS[(r.verdict ?? "unknown") as Verdict], summary, error_details, received_at: r.received_at.includes("T") ? r.received_at : r.received_at.replace(" ", "T") + "Z" };
};

/* ---------- Public ingest: POST /api/integrations/backups ---------- */
export const publicRoutes = new Hono<AppEnv>();

const ingestSchema = z.object({
  run_id: z.string().trim().min(1).max(200).optional(),
  content: z.union([z.record(z.string(), z.unknown()), z.string().max(20000)]),
});

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

publicRoutes.post("/", async (c) => {
  const expected = c.env.BACKUP_INGEST_TOKEN;
  const auth = c.req.header("Authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!expected || !given || !constantTimeEqual(given, expected)) return c.json({ error: "unauthorized" }, 401);
  const text = await c.req.text();
  if (text.length > 64 * 1024) return c.json({ error: "payload too large" }, 413);
  let parsed: z.infer<typeof ingestSchema>;
  try { parsed = ingestSchema.parse(JSON.parse(text)); } catch { return c.json({ error: "invalid input" }, 400); }
  const runId = parsed.run_id ?? c.req.header("Idempotency-Key")?.trim() ?? newId();
  // Single-owner app: receipts go to the first (allowed) user.
  const owner = await one<{ id: string }>(c.env.DB, "SELECT id FROM users ORDER BY created_at LIMIT 1");
  if (!owner) return c.json({ error: "no owner" }, 503);
  const contentJson = JSON.stringify(parsed.content);
  const dup = await one<RunRow>(c.env.DB, "SELECT * FROM backup_runs WHERE user_id=? AND run_id=?", owner.id, runId);
  if (dup) {
    if (dup.content_json !== contentJson) return c.json({ error: "run_id already received with different content", run_id: runId }, 409);
    return c.json({ ok: true, duplicate: true, run_id: runId, id: dup.id }, 200);
  }
  const n = normalizeRun(parsed.content);
  const id = newId();
  await run(c.env.DB, "INSERT INTO backup_runs (id,user_id,run_id,started_at,finished_at,duration_sec,personal_count,team_count,personal_bytes,team_bytes,errors,verdict,content_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, owner.id, runId, n.started_at, n.finished_at, n.duration_sec, n.personal_count, n.team_count, n.personal_bytes, n.team_bytes, n.errors, n.verdict, contentJson);
  await run(c.env.DB, "DELETE FROM backup_runs WHERE user_id=? AND id NOT IN (SELECT id FROM backup_runs WHERE user_id=? ORDER BY received_at DESC, rowid DESC LIMIT ?)", owner.id, owner.id, MAX_RUNS_PER_USER);
  const files = (n.personal_count ?? 0) + (n.team_count ?? 0);
  const body = [`判定: ${VERDICT_LABELS[n.verdict]}`, n.duration_sec != null ? `所要 ${formatDuration(n.duration_sec)}` : null, n.personal_count != null || n.team_count != null ? `${files.toLocaleString("ja-JP")}件` : null, n.errors ? `エラー ${n.errors}件` : null].filter(Boolean).join(" / ");
  await notify(c.env, owner.id, { kind: "backup", title: `Dropboxバックアップ: ${VERDICT_LABELS[n.verdict]}`, body, url: "/backups", dedupeKey: `backup:${runId}` });
  return c.json({ ok: true, duplicate: false, run_id: runId, id, verdict: n.verdict }, 201);
});

/* ---------- Authenticated ---------- */
export const routes = new Hono<AppEnv>();

routes.get("/", async (c) => {
  const user = c.get("user");
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const total = (await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM backup_runs WHERE user_id=?", user.id))?.n ?? 0;
  const rows = await all<RunRow>(c.env.DB, "SELECT * FROM backup_runs WHERE user_id=? ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?", user.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return c.json({ runs: rows.map(toRun), page, page_size: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) });
});

routes.get("/latest", async (c) => {
  const user = c.get("user");
  const row = await one<RunRow>(c.env.DB, "SELECT * FROM backup_runs WHERE user_id=? ORDER BY received_at DESC, rowid DESC LIMIT 1", user.id);
  const latest = row ? toRun(row) : null;
  const stale = isStale(latest?.received_at);
  return c.json({ latest, stale, stale_hours: STALE_HOURS, hours_since: hoursSince(latest?.received_at), endpoint: "/api/integrations/backups", token_configured: Boolean(c.env.BACKUP_INGEST_TOKEN) });
});

/** Hourly cron: once per day, notify when no receipt has arrived for > 36h (未受信 — not a failure). */
export async function checkBackupStaleness(env: Env, userId: string) {
  const row = await one<{ received_at: string }>(env.DB, "SELECT received_at FROM backup_runs WHERE user_id=? ORDER BY received_at DESC LIMIT 1", userId);
  const last = row ? (row.received_at.includes("T") ? row.received_at : row.received_at.replace(" ", "T") + "Z") : null;
  if (!row) return; // never connected: nothing to warn about
  if (!isStale(last)) return;
  const hrs = Math.floor(hoursSince(last) ?? 0);
  await notify(env, userId, { kind: "backup", title: "バックアップ結果が未受信です", body: `最後の受信から約${hrs}時間経過しています。別PCの実行ログと送信設定を確認してください（失敗と断定するものではありません）。`, url: "/backups", dedupeKey: `backup-stale:${jstDate()}` });
}
