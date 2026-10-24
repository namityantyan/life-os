import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { Env } from "../env";
import { all, run } from "./db";

/**
 * Web Push delivery (RFC 8030 + VAPID RFC 8292 + aes128gcm RFC 8291) using WebCrypto only,
 * so it runs the same on Node (self-hosted server) and Workers. Endpoints: FCM (Chrome / Android / Edge),
 * Apple (Safari on macOS 13+, iOS 16.4+ home-screen apps), Mozilla.
 */
export type PushPayload = { title: string; body: string; url: string; tag: string };
export type PushSub = { id: string; endpoint: string; p256dh: string; auth: string; label?: string | null };
export type PushResult = { id: string; label: string | null; ok: boolean; status: number | null; removed: boolean; error: string | null };

export const pushConfigured = (env: Env) => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
/** Apple rejects JWTs whose `sub` is not a real mailto:/https: contact, so fall back to the app origin. */
export const vapidSubject = (env: Env) => env.VAPID_SUBJECT || env.APP_ORIGIN.replace(/\/$/, "");

/** Build the fetch init for one subscription (headers: Authorization vapid, TTL, Urgency, Content-Encoding aes128gcm). */
export async function buildPushRequest(env: Env, sub: Pick<PushSub, "endpoint" | "p256dh" | "auth">, payload: PushPayload, ttlSec = 3600) {
  const req = await buildPushPayload(
    { data: JSON.stringify(payload), options: { ttl: Math.max(60, Math.min(Math.round(ttlSec), 2419200)), urgency: "high" } },
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }, expirationTime: null },
    { subject: vapidSubject(env), publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! },
  );
  const headers: Record<string, string> = { ...(req.headers as Record<string, string>) };
  delete headers["content-length"]; // Node's fetch sets it from the body
  return { method: "POST", headers, body: req.body as Uint8Array };
}

/**
 * Send to the given subscriptions. 404/410 (gone) deletes the subscription; other failures are stored
 * on the row (last_error) so the settings screen can show which device is not receiving.
 */
export async function sendToSubscriptions(env: Env, subs: PushSub[], payload: PushPayload, ttlSec = 3600): Promise<PushResult[]> {
  const out: PushResult[] = [];
  for (const s of subs) {
    const r: PushResult = { id: s.id, label: s.label ?? null, ok: false, status: null, removed: false, error: null };
    try {
      const res = await fetch(s.endpoint, await buildPushRequest(env, s, payload, ttlSec));
      r.status = res.status; r.ok = res.status >= 200 && res.status < 300;
      if (res.status === 404 || res.status === 410) { r.removed = true; await run(env.DB, "DELETE FROM push_subscriptions WHERE id=?", s.id); }
      else if (!r.ok) r.error = `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim();
    } catch (e) { r.error = String((e as Error)?.message ?? e).slice(0, 200); }
    if (r.ok) await run(env.DB, "UPDATE push_subscriptions SET last_ok_at=datetime('now'), last_error=NULL WHERE id=?", s.id);
    else if (!r.removed) await run(env.DB, "UPDATE push_subscriptions SET last_error=? WHERE id=?", r.error, s.id);
    out.push(r);
  }
  return out;
}

export async function userSubscriptions(env: Env, userId: string, id?: string) {
  return all<PushSub>(env.DB, `SELECT id,endpoint,p256dh,auth,label FROM push_subscriptions WHERE user_id=? AND enabled=1${id ? " AND id=?" : ""}`, ...(id ? [userId, id] : [userId]));
}
