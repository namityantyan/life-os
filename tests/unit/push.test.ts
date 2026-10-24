import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATION_KINDS } from "../../shared/types";
import { NOTIFICATION_MODULES, deviceLabel, moduleOfKind, normalizePushPrefs, pushAllowed, withKind, withModule } from "../../shared/notifications";
import { D1Shim, migrate } from "../../hub/d1";
import { buildPushRequest } from "../../worker/core/push";
import { notify, processQueue } from "../../worker/core/notify";
import type { Env } from "../../worker/env";

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

describe("push prefs by module", () => {
  it("puts every kind in exactly one module", () => {
    for (const k of NOTIFICATION_KINDS) expect(NOTIFICATION_MODULES.filter((m) => (m.kinds as readonly string[]).includes(k)).length).toBe(1);
    expect(moduleOfKind("images")).toBe("images");
    expect(moduleOfKind("invoice")).toBe("finance");
  });
  it("defaults everything on", () => {
    const p = normalizePushPrefs(undefined);
    expect(Object.values(p.modules).every(Boolean)).toBe(true);
    expect(NOTIFICATION_KINDS.every((k) => pushAllowed(p, k))).toBe(true);
  });
  it("seeds from legacy { kind: { push, discord } } and turns a module off only when all its kinds were off", () => {
    const p = normalizePushPrefs(undefined, { fx: { push: false, discord: true }, invoice: { push: false, discord: false }, withholding: { push: true, discord: false } });
    expect(p.modules.fx).toBe(false);
    expect(pushAllowed(p, "fx")).toBe(false);
    expect(p.modules.finance).toBe(true);
    expect(pushAllowed(p, "invoice")).toBe(false);
    expect(pushAllowed(p, "withholding")).toBe(true);
    expect(pushAllowed(p, "images")).toBe(true); // kinds added later default on
  });
  it("prefers stored push_prefs over legacy and fills missing keys with on", () => {
    const p = normalizePushPrefs({ modules: { training: false }, kinds: { morning: false } }, { training: { push: true } , fx: { push: false } });
    expect(pushAllowed(p, "training")).toBe(false);
    expect(pushAllowed(p, "fx")).toBe(true);
    expect(pushAllowed(p, "morning")).toBe(false);
    expect(pushAllowed(p, "weekly")).toBe(true);
    expect(normalizePushPrefs("junk").modules.fx).toBe(true);
  });
  it("module off blocks its kinds; module on with all kinds off turns them back on", () => {
    let p = normalizePushPrefs(undefined);
    p = withModule(p, "finance", false);
    expect(pushAllowed(p, "invoice")).toBe(false);
    p = withKind(withKind(p, "invoice", false), "withholding", false);
    p = withModule(p, "finance", true);
    expect(pushAllowed(p, "invoice") && pushAllowed(p, "withholding")).toBe(true);
  });
  it("kind switches drive the module", () => {
    let p = withModule(normalizePushPrefs(undefined), "dashboard", false);
    p = withKind(p, "morning", true);
    expect(p.modules.dashboard).toBe(true);
    expect(pushAllowed(p, "morning")).toBe(true);
    p = withKind(withKind(p, "morning", false), "weekly", false);
    expect(p.modules.dashboard).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names common devices", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe("Mac Chrome");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", true)).toBe("Mac Safari（アプリ）");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36")).toBe("Android Chrome");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", true)).toBe("iPhone（アプリ）");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toBe("Windows Edge");
  });
});

async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64u(pub), privateKey: jwk.d!, verifyKey: kp.publicKey };
}
async function clientKeys() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: kp.privateKey, p256dh: b64u(pub), auth: b64u(auth), pubBytes: pub, authBytes: auth };
}
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const enc = (s: string) => new TextEncoder().encode(s);

/** RFC 8291 / RFC 8188 receiver side, written independently of the library. */
async function decrypt(body: Uint8Array, client: Awaited<ReturnType<typeof clientKeys>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, client.privateKey, 256));
  const prkKey = await hmac(client.authBytes, ecdh);
  const ikm = (await hmac(prkKey, cat(enc("WebPush: info\0"), client.pubBytes, asPub, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let end = padded.length - 1; while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2); // last-record delimiter
  return new TextDecoder().decode(padded.slice(0, end));
}

describe("Web Push request (RFC 8291 aes128gcm + RFC 8292 VAPID) on Node", () => {
  it("round-trips the payload and signs a VAPID JWT for the push service origin", async () => {
    const v = await vapidKeys(); const c = await clientKeys();
    const env = { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, APP_ORIGIN: "https://dashboard.nami-tool.com/" } as Env;
    const payload = { title: "トレーニング終了", body: "ベンチプレス 60kg×8", url: "/training", tag: "t1" };
    const req = await buildPushRequest(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: c.p256dh, auth: c.auth }, payload, 7200);
    expect(req.headers["content-encoding"]).toBe("aes128gcm");
    expect(req.headers.ttl).toBe("7200");
    expect(req.headers["content-length"]).toBeUndefined();
    expect(req.body.byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.parse(await decrypt(req.body, c))).toEqual(payload);

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.authorization)!;
    expect(m[2]).toBe(v.publicKey);
    const [h, p, s] = m[1].split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("https://dashboard.nami-tool.com");
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v.verifyKey, fromB64u(s), enc(`${h}.${p}`));
    expect(ok).toBe(true);
  });
});

describe("notification queue delivery", () => {
  let db: D1Shim; let env: Env; let client: Awaited<ReturnType<typeof clientKeys>>;
  const dir = join(__dirname, "../../migrations");
  const addSub = (id: string, endpoint: string) => db.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,label) VALUES (?,?,?,?,?,?)").bind(id, "u1", endpoint, client.p256dh, client.auth, "Mac Chrome").run();
  const enqueue = (id: string, channel = "push") => db.prepare("INSERT INTO notification_queue (id,user_id,notification_id,kind,channel,payload_json,max_attempts,expires_at) VALUES (?,?,?,?,?,?,?,?)").bind(id, "u1", "n1", "system", channel, JSON.stringify({ title: "t", body: "", url: "/", tag: "n1" }), 5, new Date(Date.now() + 3600e3).toISOString()).run();
  const q = (id: string) => db.prepare("SELECT status,last_error,attempts FROM notification_queue WHERE id=?").bind(id).first<{ status: string; last_error: string | null; attempts: number }>();
  const subCount = async () => (await db.prepare("SELECT COUNT(*) n FROM push_subscriptions").first<number>("n"));

  beforeEach(async () => {
    db = new D1Shim(":memory:");
    migrate(db, readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") })));
    const v = await vapidKeys(); client = await clientKeys();
    env = { DB: db, APP_ORIGIN: "https://dashboard.nami-tool.com", VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey } as unknown as Env;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("deletes a subscription the push service reports gone (410) and skips the row when no device is left", async () => {
    await addSub("s1", "https://fcm.googleapis.com/fcm/send/gone");
    await enqueue("q1");
    const fetchMock = vi.fn(async () => new Response("", { status: 410 }));
    vi.stubGlobal("fetch", fetchMock);
    await processQueue(env);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await subCount()).toBe(0);
    expect((await q("q1"))?.status).toBe("skipped");
  });

  it("sends to the remaining device when another one is gone (404)", async () => {
    await addSub("s1", "https://fcm.googleapis.com/fcm/send/gone");
    await addSub("s2", "https://web.push.apple.com/ok");
    await enqueue("q1");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response("", { status: url.includes("gone") ? 404 : 201 })));
    expect((await processQueue(env)).sent).toBe(1);
    expect((await q("q1"))?.status).toBe("sent");
    const rows = (await db.prepare("SELECT id,last_ok_at FROM push_subscriptions").all<{ id: string; last_ok_at: string | null }>()).results;
    expect(rows.map((r) => r.id)).toEqual(["s2"]);
    expect(rows[0].last_ok_at).not.toBeNull();
  });

  it("keeps retrying on other errors and records them on the device", async () => {
    await addSub("s1", "https://fcm.googleapis.com/fcm/send/x");
    await enqueue("q1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("the key in the authorization header does not correspond", { status: 403 })));
    await processQueue(env);
    const row = await q("q1");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect((await db.prepare("SELECT last_error FROM push_subscriptions WHERE id='s1'").first<string>("last_error"))).toMatch(/^403/);
    // claimed / backed off: an immediate second run does not resend
    await processQueue(env);
    expect((await q("q1"))?.attempts).toBe(1);
  });

  it("cancels leftover Discord rows without calling out", async () => {
    await enqueue("q1", "discord");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await processQueue(env);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await q("q1"))?.status).toBe("cancelled");
  });

  it("notify() always records in the bell but only queues push when the module is on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })));
    await db.prepare("INSERT INTO settings (user_id,key,value_json) VALUES (?,?,?)").bind("u1", "push_prefs", JSON.stringify({ modules: { training: false }, kinds: {} })).run();
    await notify(env, "u1", { kind: "training", title: "トレーニング終了" });
    await notify(env, "u1", { kind: "fx", title: "FX 約定" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='u1'").first<number>("n")).toBe(2);
    const kinds = (await db.prepare("SELECT kind FROM notification_queue").all<{ kind: string }>()).results.map((r) => r.kind);
    expect(kinds).toEqual(["fx"]);
  });

  it("uses legacy notification_prefs until push_prefs is saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 201 })));
    await db.prepare("INSERT INTO settings (user_id,key,value_json) VALUES (?,?,?)").bind("u1", "notification_prefs", JSON.stringify({ backup: { push: false, discord: true } })).run();
    await notify(env, "u1", { kind: "backup", title: "バックアップ" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.prepare("SELECT COUNT(*) n FROM notification_queue").first<number>("n")).toBe(0);
  });
});
