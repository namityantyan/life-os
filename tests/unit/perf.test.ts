import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { dailyHint, HINT_FAILED } from "../../worker/core/context";
import { weatherFor, WEATHER_FRESH_MS, type WeatherSnapshot } from "../../worker/core/weather";
import { pickEncoding, isCompressible, compressResponse, staticFiles } from "../../server/http";
import { aiRelay } from "../../server/shims";
import { D1Shim } from "../../hub/d1";
import { cacheGet, cacheSet, cacheHas, cacheClear, cacheEpoch, cacheSetIfCurrent, invalidateFor, moduleOf } from "../../src/lib/apiCache";
import { api } from "../../src/lib/api";
import type { LifeContext } from "../../shared/types";

const kvMock = () => {
  const m = new Map<string, string>(); const ttl = new Map<string, number | undefined>();
  return { m, ttl, async get(k: string, t?: string) { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k: string, v: string, o?: { expirationTtl?: number }) { m.set(k, v); ttl.set(k, o?.expirationTtl); } };
};
const ctx = { now: "2026-10-21T09:00:00+09:00", user: { name: "n" }, health: { oura: null, oura_is_today: false, pressure: null, checkup_latest: null, meal_summary: null, beauty_routine_count: 0 }, training: { trained_today: false, last_session: null, sessions_7d: 0 }, planner: { tasks_open: 0, events_today: [], reminders_pending: 0 }, money: { card_month_total: null, card_budget: null, card_budget_left: null, personal_jpy_cash: null, cash_is_fresh: false }, fx: { open_positions: 0, connector_online: false }, notes: [] } as unknown as LifeContext;
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("dailyHint", () => {
  it("returns the rule-based hint at once and generates the AI hint in the background", async () => {
    const KV = kvMock(); let resolveAi!: (v: unknown) => void;
    const AI = { run: vi.fn(() => new Promise((r) => { resolveAi = r; })) };
    const env = { KV, AI } as any; const bg: Promise<unknown>[] = [];
    const first = await dailyHint(env, "u1", ctx, { background: (p) => bg.push(p) });
    expect(first.source).toBe("rules");
    expect(bg).toHaveLength(1);
    await dailyHint(env, "u1", ctx, { background: (p) => bg.push(p) }); // in flight → not started twice
    expect(bg).toHaveLength(1);
    resolveAi({ response: "「朝のうちに散歩を。」" }); await bg[0];
    expect(await dailyHint(env, "u1", ctx, { background: (p) => bg.push(p) })).toEqual({ text: "朝のうちに散歩を。", source: "ai" });
    expect(AI.run).toHaveBeenCalledTimes(1);
    expect(AI.run.mock.calls[0]).toHaveLength(3); // passes the short-timeout option to the relay
  });
  it("caches an AI failure for 10 minutes so it isn't retried on every request", async () => {
    const KV = kvMock(); const AI = { run: vi.fn(async () => { throw new Error("relay down"); }) };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { KV, AI } as any; const bg: Promise<unknown>[] = [];
    await dailyHint(env, "u1", ctx, { background: (p) => bg.push(p) }); await Promise.all(bg);
    const key = [...KV.m.keys()].find((k) => k.startsWith("hint:"))!;
    expect(KV.m.get(key)).toBe(HINT_FAILED); expect(KV.ttl.get(key)).toBe(600);
    expect((await dailyHint(env, "u1", ctx, { background: (p) => bg.push(p) })).source).toBe("rules");
    expect(AI.run).toHaveBeenCalledTimes(1);
  });
  it("awaits the AI when no background runner is given (cron)", async () => {
    const env = { KV: kvMock(), AI: { run: vi.fn(async () => ({ response: "整っています。" })) } } as any;
    expect(await dailyHint(env, "u1", ctx)).toEqual({ text: "整っています。", source: "ai" });
  });
});

describe("weatherFor (stale-while-revalidate)", () => {
  const loc = { lat: 35.68, lon: 139.76, name: "Tokyo" } as any;
  const snap = (agoMs: number, t = 20): WeatherSnapshot => ({ location: loc, temperature: t, weather_code: 0, precipitation_probability: 0, pressure: {} as any, pressure_series: [], fetched_at: new Date(Date.now() - agoMs).toISOString() });
  it("fetches when nothing is cached and stores with a long TTL", async () => {
    const KV = kvMock(); const fetcher = vi.fn(async () => snap(0));
    expect((await weatherFor({ KV } as any, loc, undefined, fetcher)).temperature).toBe(20);
    expect(fetcher).toHaveBeenCalledTimes(1); expect([...KV.ttl.values()][0]).toBe(2 * 86400);
  });
  it("serves a fresh snapshot without fetching", async () => {
    const KV = kvMock(); KV.m.set("weather:v2:35.68,139.76", JSON.stringify(snap(60e3)));
    const fetcher = vi.fn(async () => snap(0, 99));
    expect((await weatherFor({ KV } as any, loc, undefined, fetcher)).temperature).toBe(20);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("serves a stale snapshot at once and refreshes it in the background", async () => {
    const KV = kvMock(); KV.m.set("weather:v2:35.68,139.76", JSON.stringify(snap(WEATHER_FRESH_MS + 60e3)));
    const fetcher = vi.fn(async () => snap(0, 99)); const bg: Promise<unknown>[] = [];
    expect((await weatherFor({ KV } as any, loc, (p) => bg.push(p), fetcher)).temperature).toBe(20);
    expect(bg).toHaveLength(1); await bg[0];
    expect((await weatherFor({ KV } as any, loc, (p) => bg.push(p), fetcher)).temperature).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("falls back to a very old snapshot when the fetch fails", async () => {
    const KV = kvMock(); KV.m.set("weather:v2:35.68,139.76", JSON.stringify(snap(10 * 3600e3)));
    expect((await weatherFor({ KV } as any, loc, undefined, async () => { throw new Error("down"); })).temperature).toBe(20);
    await expect(weatherFor({ KV: kvMock() } as any, loc, undefined, async () => { throw new Error("down"); })).rejects.toThrow("down");
  });
});

describe("compression", () => {
  it("picks br over gzip and honours q=0", () => {
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
    expect(pickEncoding("gzip, br;q=0")).toBe("gzip");
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding(null)).toBeNull();
  });
  it("only compresses text-like types, never event streams", () => {
    expect(isCompressible("application/json; charset=UTF-8")).toBe(true);
    expect(isCompressible("text/event-stream")).toBe(false);
    expect(isCompressible("image/png")).toBe(false);
  });
  it("compresses large JSON and leaves small or binary bodies alone", async () => {
    const big = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, t: "テスト" })) });
    const r = await compressResponse(new Response(big, { headers: { "Content-Type": "application/json" } }), "gzip");
    expect(r.headers.get("Content-Encoding")).toBe("gzip"); expect(r.headers.get("Vary")).toMatch(/Accept-Encoding/);
    expect(gunzipSync(new Uint8Array(await r.arrayBuffer())).toString()).toBe(big);
    const small = await compressResponse(new Response("{}", { headers: { "Content-Type": "application/json" } }), "br");
    expect(small.headers.get("Content-Encoding")).toBeNull(); expect(await small.text()).toBe("{}");
    const sse = await compressResponse(new Response("data: x\n\n".repeat(500), { headers: { "Content-Type": "text/event-stream" } }), "br");
    expect(sse.headers.get("Content-Encoding")).toBeNull();
  });
  it("serves static files from memory with ETag/304, precompressed siblings and SPA fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-static-"));
    mkdirSync(join(root, "assets"));
    const js = "console.log('x');".repeat(200);
    writeFileSync(join(root, "assets", "app.js"), js); writeFileSync(join(root, "assets", "app.js.gz"), "PRE");
    writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>"); writeFileSync(join(root, "sw.js"), "self.x=1;".repeat(200));
    const s = staticFiles(root);
    const a = await s.fetch(new Request("http://x/assets/app.js", { headers: { "Accept-Encoding": "gzip" } }));
    expect(a.headers.get("Content-Encoding")).toBe("gzip"); expect(await a.text()).toBe("PRE");
    expect(a.headers.get("Cache-Control")).toMatch(/immutable/);
    const b = await s.fetch(new Request("http://x/assets/app.js", { headers: { "Accept-Encoding": "br" } }));
    expect(brotliDecompressSync(new Uint8Array(await b.arrayBuffer())).toString()).toBe(js); // compressed lazily
    const nm = await s.fetch(new Request("http://x/assets/app.js", { headers: { "If-None-Match": b.headers.get("ETag")! } }));
    expect(nm.status).toBe(304);
    const sw = await s.fetch("http://x/sw.js"); expect(sw.headers.get("Cache-Control")).toBe("no-cache");
    const spa = await s.fetch("http://x/fx/chart"); expect(await spa.text()).toMatch(/doctype/); expect(spa.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(await (await s.fetch("http://x/assets/app.js.gz")).text()).toMatch(/doctype/); // precompressed files aren't exposed
  });
});

describe("AI relay options", () => {
  it("uses the short timeout without retry when asked", async () => {
    const f = vi.fn(async () => new Response("busy", { status: 503 })); vi.stubGlobal("fetch", f);
    await expect(aiRelay("https://relay", "s")!.run("m", {}, { timeoutMs: 50, retry: false })).rejects.toThrow(/503/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("D1 shim statement cache", () => {
  it("reuses compiled statements across calls and survives schema changes", async () => {
    const db = new D1Shim(":memory:"); db.optimize();
    await db.exec("CREATE TABLE t (a INTEGER)");
    for (let i = 0; i < 3; i++) await db.prepare("INSERT INTO t (a) VALUES (?)").bind(i).run();
    expect(db.stmt("SELECT COUNT(*) n FROM t")).toBe(db.stmt("SELECT COUNT(*) n FROM t"));
    await db.exec("ALTER TABLE t ADD COLUMN b TEXT");
    expect((await db.prepare("SELECT * FROM t ORDER BY a").all()).results[0]).toEqual({ a: 0, b: null });
  });
});

describe("useApi cache", () => {
  it("keys by path, drops a module's entries (and /dashboard) on mutation, clears all on /auth", () => {
    cacheClear();
    cacheSet("/notes", [1]); cacheSet("/notes?q=a", [2]); cacheSet("/fx/status", 3); cacheSet("/dashboard", 4);
    expect(moduleOf("/fx/chart?pair=USD/JPY")).toBe("fx");
    invalidateFor("/notes/abc");
    expect(cacheHas("/notes")).toBe(false); expect(cacheHas("/notes?q=a")).toBe(false); expect(cacheHas("/dashboard")).toBe(false);
    expect(cacheGet("/fx/status")).toBe(3);
    invalidateFor("/auth/logout"); expect(cacheHas("/fx/status")).toBe(false);
  });
  it("skips writing a GET result that started before a mutation", () => {
    cacheClear(); const at = cacheEpoch(); invalidateFor("/notes"); cacheSetIfCurrent("/notes", "old", at);
    expect(cacheHas("/notes")).toBe(false);
    cacheSetIfCurrent("/notes", "new", cacheEpoch()); expect(cacheGet("/notes")).toBe("new");
  });
  it("api mutations invalidate the cache even when they fail", async () => {
    cacheClear(); cacheSet("/planner/items", 1); cacheSet("/health/summary", 2);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 })));
    await expect(api.post("/planner/items", { title: "x" })).rejects.toThrow("bad");
    expect(cacheHas("/planner/items")).toBe(false); expect(cacheHas("/health/summary")).toBe(true);
    await flush();
  });
});
