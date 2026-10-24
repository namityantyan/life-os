// Life OS service worker: push notifications only. No caching of authenticated data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Every push must show a notification (Safari revokes the permission otherwise).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Life OS", {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    data: { url: data.url || "/" },
    tag: data.tag || undefined,
    timestamp: Date.now(),
  }));
});

// Focus an open Life OS window and route it in-app (the page listens for "lifeos:navigate"); otherwise open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname + url.search + url.hash;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = list.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      const focused = await win.focus().catch(() => win);
      (focused || win).postMessage({ type: "lifeos:navigate", url: path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});

// The push service rotated or expired the subscription: subscribe again and swap it on the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription || null;
    let sub = event.newSubscription || null;
    if (!sub) {
      let key = old && old.options && old.options.applicationServerKey;
      if (!key) { const r = await fetch("/api/integrations/push/config"); const j = await r.json(); key = j.publicKey; }
      if (!key) return;
      if (typeof key === "string") { const b = atob((key + "===".slice((key.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); key = Uint8Array.from(b, (ch) => ch.charCodeAt(0)); }
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    if (!old) return; // nothing to match on; the page re-registers on next open
    await fetch("/api/integrations/push/rotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldEndpoint: old.endpoint, subscription: sub.toJSON() }) });
  })());
});
