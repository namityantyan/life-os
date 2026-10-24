// Web Push on this device: service worker, permission, subscription, and keeping the server's copy current.
import { deviceLabel } from "@shared/notifications";
import { api } from "./api";

export type PushPermission = "unsupported" | "needs-install" | NotificationPermission;
const FLAG = "lifeos-push"; // "1" while this browser is meant to receive push

const flag = { get: () => { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } }, set: (on: boolean) => { try { on ? localStorage.setItem(FLAG, "1") : localStorage.removeItem(FLAG); } catch { /* private mode */ } } };
export const isStandalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const thisDeviceLabel = () => deviceLabel(navigator.userAgent, isStandalone());

export function pushPermission(): PushPermission {
  const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!ok) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  return Notification.permission;
}

function b64urlToBytes(b64: string) { const raw = atob((b64 + "===".slice((b64.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
function sameKey(sub: PushSubscription, publicKey: string) {
  const k = sub.options?.applicationServerKey; if (!k) return null; // unknown (older Safari): ask the server instead
  const a = new Uint8Array(k); const b = b64urlToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Register /sw.js (root scope) and wait until it is active; subscribe() fails on a registration that is still installing. */
export async function swReady() {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}
export async function currentSubscription() {
  if (pushPermission() !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

async function subscribeWith(reg: ServiceWorkerRegistration, publicKey: string, replaces?: string) {
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  const j = sub.toJSON();
  await api.post("/push/subscribe", { endpoint: j.endpoint, keys: j.keys, label: thisDeviceLabel(), replaces });
  flag.set(true);
  return sub;
}

/**
 * Turn push on for this device. Call directly from a click handler: Safari only shows the permission
 * prompt when requestPermission() is the first thing awaited in the user gesture.
 */
export async function enablePush(publicKey: string): Promise<NotificationPermission> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm;
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  const old = sub?.endpoint;
  if (sub && sameKey(sub, publicKey) === false) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (sub) { const j = sub.toJSON(); await api.post("/push/subscribe", { endpoint: j.endpoint, keys: j.keys, label: thisDeviceLabel() }); flag.set(true); }
  else await subscribeWith(reg, publicKey, old);
  return "granted";
}

export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) { await api.post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  flag.set(false);
}

/**
 * On app start: keep this browser's subscription valid without asking again. Re-subscribes when the
 * browser lost it or the server's VAPID key changed; drops it when the device was removed from the list.
 */
export async function syncPush() {
  if (pushPermission() !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub && !flag.get()) return;
  const cfg = await api.get<{ publicKey: string | null; known: boolean; stale: boolean }>(`/push/config${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ""}`);
  if (!cfg.publicKey) return;
  if (sub && !cfg.known && !flag.get()) return;
  if (sub && !cfg.known) { await sub.unsubscribe().catch(() => {}); flag.set(false); return; } // removed in settings (or gone at the push service)
  if (sub && !cfg.stale && sameKey(sub, cfg.publicKey) !== false) { flag.set(true); return; }
  if (sub) await sub.unsubscribe().catch(() => {});
  await subscribeWith(reg, cfg.publicKey, sub?.endpoint);
}

/** Notification clicks from the service worker arrive as messages; route them without a full reload. */
export function listenForNavigation(go: (url: string) => void) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => { const d = e.data as { type?: string; url?: string } | null; if (d?.type === "lifeos:navigate" && typeof d.url === "string" && d.url.startsWith("/")) go(d.url); });
  navigator.serviceWorker.startMessages?.();
}
