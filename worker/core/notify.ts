import type { Env } from "../env";
import type { NotificationKind } from "../../shared/types";
import { normalizePushPrefs, pushAllowed, type PushPrefs } from "../../shared/notifications";
import { all, run, newId, one } from "./db";
import { pushConfigured, sendToSubscriptions, userSubscriptions, type PushPayload } from "./push";

/** Push prefs for a user: "push_prefs", seeded from the legacy per-kind "notification_prefs" when absent. */
export async function loadPushPrefs(env: Env, userId: string): Promise<PushPrefs> {
  const rows = await all<{ key: string; value_json: string }>(env.DB, "SELECT key,value_json FROM settings WHERE user_id=? AND key IN ('push_prefs','notification_prefs')", userId);
  const get = (k: string) => { const r = rows.find((x) => x.key === k); try { return r ? JSON.parse(r.value_json) : undefined; } catch { return undefined; } };
  return normalizePushPrefs(get("push_prefs"), get("notification_prefs"));
}

const KIND_TTL_MIN: Partial<Record<NotificationKind, number>> = { reminder: 60, morning: 180, bedtime: 120, training: 120, weekly: 720, system: 60 };

/**
 * Create an in-app notification (always) and enqueue a push when the user's module/kind switches allow it.
 * FX trade notifications get a long expiry and more retries so they are never dropped.
 */
export async function notify(env: Env, userId: string, n: { kind: NotificationKind; title: string; body?: string; url?: string; dedupeKey?: string }) {
  if (n.dedupeKey) {
    const dup = await one(env.DB, "SELECT 1 FROM job_runs WHERE job=? AND key=?", "notify", n.dedupeKey);
    if (dup) return null;
    await run(env.DB, "INSERT INTO job_runs (job,key) VALUES (?,?)", "notify", n.dedupeKey);
  }
  const id = newId();
  await run(env.DB, "INSERT INTO notifications (id,user_id,kind,title,body,url) VALUES (?,?,?,?,?,?)", id, userId, n.kind, n.title, n.body ?? null, n.url ?? null);
  if (!pushAllowed(await loadPushPrefs(env, userId), n.kind)) return id;
  const ttlMin = n.kind === "fx" ? 60 * 24 * 3 : (KIND_TTL_MIN[n.kind] ?? 240);
  const maxAttempts = n.kind === "fx" ? 20 : 5;
  const expires = new Date(Date.now() + ttlMin * 60000).toISOString();
  const payload: PushPayload = { title: n.title, body: n.body ?? "", url: n.url ?? "/", tag: id };
  await run(env.DB, "INSERT INTO notification_queue (id,user_id,notification_id,kind,channel,payload_json,max_attempts,expires_at) VALUES (?,?,?,?,?,?,?,?)", newId(), userId, id, n.kind, "push", JSON.stringify(payload), maxAttempts, expires);
  // Deliver now instead of waiting for the 10-minute cron (on Node the promise simply runs on).
  void processQueue(env, 10).catch((e) => console.error("push delivery", e));
  return id;
}

type QueueRow = { id: string; user_id: string; kind: string; channel: string; payload_json: string; attempts: number; max_attempts: number; expires_at: string | null };

/**
 * Deliver pending queue items (called by cron and after creation). A row is sent when at least one device
 * accepted it; with no devices (or no VAPID keys) it is skipped instead of retried. Non-push rows (the old
 * Discord channel) are cancelled.
 */
export async function processQueue(env: Env, limit = 50) {
  const rows = await all<QueueRow>(env.DB, "SELECT * FROM notification_queue WHERE status='pending' AND next_attempt_at<=datetime('now') ORDER BY created_at LIMIT ?", limit);
  let sent = 0;
  for (const row of rows) {
    const left = row.expires_at ? (Date.parse(row.expires_at) - Date.now()) / 1000 : 3600;
    if (left <= 0) { await run(env.DB, "UPDATE notification_queue SET status='expired' WHERE id=?", row.id); continue; }
    // Claim the row for 2 minutes so the cron and an immediate delivery never send it twice.
    const claim = await run(env.DB, "UPDATE notification_queue SET next_attempt_at=datetime('now','+2 minutes') WHERE id=? AND status='pending' AND next_attempt_at<=datetime('now')", row.id);
    if (!claim.meta?.changes) continue;
    if (row.channel !== "push") { await run(env.DB, "UPDATE notification_queue SET status='cancelled', last_error=? WHERE id=?", `${row.channel} disabled`, row.id); continue; }
    const subs = pushConfigured(env) ? await userSubscriptions(env, row.user_id) : [];
    if (subs.length === 0) { await run(env.DB, "UPDATE notification_queue SET status='skipped', last_error=? WHERE id=?", pushConfigured(env) ? "no devices" : "vapid not configured", row.id); continue; }
    const results = await sendToSubscriptions(env, subs, JSON.parse(row.payload_json) as PushPayload, left);
    if (results.some((r) => r.ok)) { sent++; await run(env.DB, "UPDATE notification_queue SET status='sent', attempts=attempts+1 WHERE id=?", row.id); continue; }
    const err = results.map((r) => r.error ?? (r.removed ? "gone" : "")).filter(Boolean).join("; ") || "no devices";
    const attempts = row.attempts + 1;
    const status = results.every((r) => r.removed) ? "skipped" : attempts >= row.max_attempts ? "failed" : "pending";
    await run(env.DB, "UPDATE notification_queue SET attempts=?, status=?, last_error=?, next_attempt_at=datetime('now', ?) WHERE id=?", attempts, status, err.slice(0, 500), `+${Math.min(60, 2 ** attempts)} minutes`, row.id);
  }
  return { processed: rows.length, sent };
}
