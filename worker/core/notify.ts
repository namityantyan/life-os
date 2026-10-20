import type { Env } from "../env";
import type { NotificationKind, NotificationPrefs } from "../../shared/types";
import { NOTIFICATION_KINDS } from "../../shared/types";
import { all, run, newId, getSetting, one } from "./db";

export const DEFAULT_PREFS: NotificationPrefs = Object.fromEntries(
  NOTIFICATION_KINDS.map((k) => [k, { push: true, discord: false }]),
) as NotificationPrefs;

const KIND_TTL_MIN: Partial<Record<NotificationKind, number>> = { reminder: 60, morning: 180, bedtime: 120, training: 120, weekly: 720, system: 60 };

/**
 * Create an in-app notification and enqueue deliveries by the user's preferences.
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
  const prefs = await getSetting<NotificationPrefs>(env, userId, "notification_prefs", DEFAULT_PREFS);
  const p = prefs[n.kind] ?? { push: true, discord: false };
  const ttlMin = n.kind === "fx" ? 60 * 24 * 3 : (KIND_TTL_MIN[n.kind] ?? 240);
  const maxAttempts = n.kind === "fx" ? 20 : 5;
  const expires = new Date(Date.now() + ttlMin * 60000).toISOString();
  const payload = JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? "/", tag: id });
  if (p.push) await run(env.DB, "INSERT INTO notification_queue (id,user_id,notification_id,kind,channel,payload_json,max_attempts,expires_at) VALUES (?,?,?,?,?,?,?,?)", newId(), userId, id, n.kind, "push", payload, maxAttempts, expires);
  if (p.discord) await run(env.DB, "INSERT INTO notification_queue (id,user_id,notification_id,kind,channel,payload_json,max_attempts,expires_at) VALUES (?,?,?,?,?,?,?,?)", newId(), userId, id, n.kind, "discord", payload, maxAttempts, expires);
  return id;
}

type QueueRow = { id: string; user_id: string; kind: string; channel: string; payload_json: string; attempts: number; max_attempts: number; expires_at: string | null };

/** Deliver pending queue items (called by cron and after creation). */
export async function processQueue(env: Env, limit = 50) {
  const rows = await all<QueueRow>(env.DB, "SELECT * FROM notification_queue WHERE status='pending' AND next_attempt_at<=datetime('now') ORDER BY created_at LIMIT ?", limit);
  let sent = 0;
  for (const row of rows) {
    if (row.expires_at && row.expires_at < new Date().toISOString()) {
      await run(env.DB, "UPDATE notification_queue SET status='expired' WHERE id=?", row.id); continue;
    }
    const payload = JSON.parse(row.payload_json) as { title: string; body: string; url: string; tag: string };
    let ok = false; let err = "";
    try {
      ok = row.channel === "push" ? await sendPush(env, row.user_id, payload) : await sendDiscord(env, row.user_id, payload);
    } catch (e) { err = String(e); }
    if (ok) { sent++; await run(env.DB, "UPDATE notification_queue SET status='sent', attempts=attempts+1 WHERE id=?", row.id); }
    else {
      const attempts = row.attempts + 1;
      const backoffMin = Math.min(60, 2 ** attempts);
      const status = attempts >= row.max_attempts ? "failed" : "pending";
      await run(env.DB, "UPDATE notification_queue SET attempts=?, status=?, last_error=?, next_attempt_at=datetime('now', ?) WHERE id=?", attempts, status, err || "no channel target", `+${backoffMin} minutes`, row.id);
    }
  }
  return { processed: rows.length, sent };
}

async function sendPush(env: Env, userId: string, payload: { title: string; body: string; url: string; tag: string }): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  const subs = await all<{ id: string; endpoint: string; p256dh: string; auth: string }>(env.DB, "SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=? AND enabled=1", userId);
  if (subs.length === 0) return false;
  const { buildPushPayload } = await import("@block65/webcrypto-web-push");
  let any = false;
  for (const s of subs) {
    try {
      const req = await buildPushPayload(
        { data: JSON.stringify(payload), options: { ttl: 3600, urgency: "high" } },
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth }, expirationTime: null },
        { subject: env.VAPID_SUBJECT ?? "mailto:admin@example.com", publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
      );
      const res = await fetch(s.endpoint, req as any);
      if (res.status === 404 || res.status === 410) { await run(env.DB, "UPDATE push_subscriptions SET enabled=0 WHERE id=?", s.id); continue; }
      if (res.ok || res.status === 201) any = true;
    } catch { /* try next device */ }
  }
  return any;
}

async function sendDiscord(env: Env, userId: string, payload: { title: string; body: string; url: string }): Promise<boolean> {
  if (!env.DISCORD_BOT_TOKEN) return false;
  const link = await one<{ discord_user_id: string }>(env.DB, "SELECT discord_user_id FROM discord_links WHERE user_id=?", userId);
  if (!link) return false;
  // Open a DM channel then post.
  const dm = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST", headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: link.discord_user_id }),
  });
  if (!dm.ok) return false;
  const ch = (await dm.json()) as { id: string };
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  const content = `**${payload.title}**\n${payload.body}${payload.url ? `\n${origin}${payload.url}` : ""}`;
  const res = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
    method: "POST", headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.ok;
}
