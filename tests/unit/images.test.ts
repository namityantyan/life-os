import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { D1Shim, migrate } from "../../hub/d1";
import { dirImageStore } from "../../server/shims";
import type { AppEnv, Env } from "../../worker/env";
import { routes, syncPendingImages } from "../../worker/modules/images/routes";
import { guardText, hasTerm, normalizeTags, parseConversion, decideRating, looksLikeTags, clampCount, refuseMessage, serviceError, systemPromptFor, photoAdultTags, photoR18YouthHit, IMAGE_SYSTEM_PROMPT, PHOTO_SYSTEM_PROMPT, PHOTO_R18_SYSTEM_PROMPT } from "../../worker/modules/images/logic";

describe("images guard", () => {
  it("refuses minor terms always (same list as the service)", () => {
    expect(guardText("1girl, loli, smile").ok).toBe(false);
    expect(guardText("幼女が笑っている").ok).toBe(false);
    expect(guardText("小学生の女の子").ok).toBe(false);
    expect(guardText("LITTLE GIRL in a park").ok).toBe(false);
  });
  it("allows youth words in all-ages pictures, refuses them with sexual content or r18", () => {
    expect(guardText("少女が花畑で微笑む").ok).toBe(true);
    expect(guardText("1girl, school uniform, smile").ok).toBe(true);
    expect(guardText("1girl, school uniform, nude").ok).toBe(false);
    expect(guardText("制服の女の子のエロい絵").ok).toBe(false);
    const r = guardText("1girl, school uniform", "r18");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("minor");
    expect(guardText("1girl, mature female, lingerie", "r18").ok).toBe(true);
  });
  it("refuses obvious named characters, artist styles and image-to-image", () => {
    const n = guardText("初音ミクを描いて");
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.code).toBe("named");
    expect(guardText("1girl, in the style of someone").ok).toBe(false);
    expect(guardText("この画像をアニメ風にして").ok).toBe(false);
  });
  it("matches ASCII terms on word boundaries only", () => {
    expect(hasTerm("marionette, stage", "mario")).toBe(false);
    expect(hasTerm("super mario", "mario")).toBe(true);
    expect(hasTerm("kidney beans", "kid")).toBe(false);
    expect(hasTerm("hatsune_miku", "hatsune miku")).toBe(true);
    expect(guardText("1girl, sexy, kidney").ok).toBe(true);
  });
});

describe("images tags", () => {
  it("normalises: lower-case, dedupe, drops quality/rating tags and non-ASCII", () => {
    expect(normalizeTags("Masterpiece, best quality, 1girl, Solo,  white_dress , 1girl, nsfw, rating:general, 花畑, flower garden"))
      .toBe("1girl, solo, white dress, flower garden");
    expect(normalizeTags(["1girl", "smile", "Smile"])).toBe("1girl, smile");
    expect(normalizeTags("1girl\nsmile、blue sky")).toBe("1girl, smile, blue sky");
  });
  it("parses the AI answer and fails closed on unknown refusals", () => {
    expect(parseConversion({ refuse: null, tags: "1girl, solo, best quality", rating: "all_ages", count: 9 })).toEqual({ refuse: null, reason: "", tags: "1girl, solo", rating: "all_ages", count: 4 });
    expect(parseConversion({ refuse: "something_new", tags: "x" })?.refuse).toBe("something_new");
    expect(refuseMessage("something_new", "")).toBe("この内容は生成できません。");
    expect(refuseMessage("real_person")).toContain("実在");
    expect(parseConversion("nope")).toBeNull();
  });
  it("r18 only when requested or explicitly asked in the user's words", () => {
    expect(decideRating(undefined, "r18", "かわいい女の子")).toBe("all_ages");
    expect(decideRating(undefined, "r18", "R18で大人の女性")).toBe("r18");
    expect(decideRating("all_ages", "r18", "R18で")).toBe("all_ages");
    expect(decideRating("r18", "all_ages", "大人の女性")).toBe("r18");
  });
  it("misc helpers", () => {
    expect(looksLikeTags("1girl, solo")).toBe(true);
    expect(looksLikeTags("女の子")).toBe(false);
    expect(clampCount(0)).toBe(1); expect(clampCount(7)).toBe(4); expect(clampCount("2")).toBe(2);
    expect(serviceError({ detail: { error: "banned_term", message: "禁止語" } })).toEqual({ error: "banned_term", message: "禁止語" });
    expect(serviceError({ detail: "unauthorized" }).message).toBe("unauthorized");
  });
});

describe("image dir store", () => {
  it("round-trips bytes and rejects keys that leave the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifeos-img-"));
    try {
      const s = dirImageStore(dir);
      await s.put("u/g/0.png", new Uint8Array([1, 2, 3]));
      expect(Array.from((await s.get("u/g/0.png"))!)).toEqual([1, 2, 3]);
      await s.delete("u/g/0.png");
      expect(await s.get("u/g/0.png")).toBeNull();
      await expect(s.put("../evil.png", new Uint8Array([1]))).rejects.toThrow();
      await expect(s.get("u/../../x")).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/* ---------- routes against an in-memory DB and a mocked Mac service ---------- */

const TOKEN = "test-token-not-real";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
type Svc = { health?: () => Response; generate?: (body: any) => Response; job?: (id: string) => Response; image?: (path: string) => Response; down?: boolean };

function setup(opts: { configured?: boolean; ai?: unknown | "down" } = {}) {
  const db = new D1Shim(":memory:");
  migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
  const ai = opts.ai === "down" ? undefined : { run: vi.fn(async () => ({ response: JSON.stringify(opts.ai ?? { refuse: null, reason: "", tags: "1girl, solo, flower garden, white dress", rating: "all_ages", count: null }) })) };
  const env = { DB: db, AI: ai, ...(opts.configured === false ? {} : { IMGGEN_URL: "http://mac.test:18787/", IMGGEN_TOKEN: TOKEN }) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: "u1", email: "a@b", name: null, picture: null }); await next(); });
  app.route("/api/images", routes);
  app.onError((err, c) => c.json({ error: String(err) }, (err as any)?.name === "ZodError" ? 400 : 500));
  const req = (path: string, init?: RequestInit) => app.request(`/api/images${path}`, init, env);
  const post = (path: string, body: unknown) => req(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { db, env, ai, req, post };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
let svc: Svc;
let calls: { url: string; auth: string | null; body?: any }[];
beforeEach(() => {
  svc = {}; calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.pathname, auth, body });
    if (svc.down) throw new TypeError("fetch failed");
    if (auth !== `Bearer ${TOKEN}`) return json({ detail: "unauthorized" }, 401);
    if (url.pathname === "/v1/health") return svc.health ? svc.health() : json({ ok: true, comfyui: "up", model_available: true, queue_length: 0 });
    if (url.pathname === "/v1/generate") return svc.generate ? svc.generate(body) : json({ job_id: "j_1", status: "queued", queue_position: 1 }, 202);
    const jm = url.pathname.match(/^\/v1\/jobs\/(.+)$/); if (jm) return svc.job ? svc.job(jm[1]!) : json({ detail: { error: "not_found" } }, 404);
    if (url.pathname.startsWith("/v1/images/")) return svc.image ? svc.image(url.pathname) : new Response(PNG, { headers: { "Content-Type": "image/png" } });
    return json({}, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("images routes", () => {
  it("status: unconfigured / offline / online, never leaking the token", async () => {
    let r = await setup({ configured: false }).req("/status");
    expect((await r.json()).status.state).toBe("unconfigured");
    const t = setup();
    svc.down = true;
    r = await t.req("/status");
    const off = await r.text();
    expect(JSON.parse(off).status.state).toBe("offline");
    svc.down = false;
    svc.health = () => json({ ok: false, comfyui: "down", model_available: false, queue_length: 0 }, 503);
    expect((await (await t.req("/status")).json()).status.message).toContain("モデル");
    svc.health = undefined;
    const on = await (await t.req("/status")).text();
    expect(JSON.parse(on).status).toMatchObject({ state: "online", comfyui: "up", model_available: true });
    expect(off + on).not.toContain(TOKEN);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("generate → poll → images copied into storage → served, listed, deleted", async () => {
    const t = setup();
    const r = await t.post("/generate", { text: "花畑の白ワンピの女の子", count: 2 });
    expect(r.status).toBe(201);
    const { item } = await r.json();
    expect(item).toMatchObject({ status: "queued", tags: "1girl, solo, flower garden, white dress", rating: "all_ages", count: 2, queue_position: 1 });
    const gen = calls.find((c) => c.url === "/v1/generate")!;
    expect(gen.body).toMatchObject({ prompt: "1girl, solo, flower garden, white dress", count: 2, rating: "all_ages", requester: "lifeos:u1" });

    svc.job = () => json({ job_id: "j_1", status: "running", done: 1, total: 2 });
    let p = await (await t.req(`/jobs/${item.id}`)).json();
    expect(p).toMatchObject({ offline: false, item: { status: "running", progress_done: 1 } });

    svc.job = () => json({ job_id: "j_1", status: "done", work_id: "w_20261024", rating: "all_ages", seeds: [11, 12], prompt: "x",
      images: [{ filename: "a_1.png", url: "/v1/images/w_20261024/a_1.png", seed: 11 }, { filename: "a_2.png", url: "/v1/images/w_20261024/a_2.png", seed: 12 }] });
    p = await (await t.req(`/jobs/${item.id}`)).json();
    expect(p.item.status).toBe("done");
    expect(p.item.files.map((f: any) => f.seed)).toEqual([11, 12]);
    expect(calls.filter((c) => c.url.startsWith("/v1/images/w_20261024/")).length).toBe(2);

    // The Mac goes away: the gallery still works from storage.
    svc.down = true;
    const fileId = p.item.files[0].id;
    const img = await t.req(`/files/${fileId}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await img.arrayBuffer()))).toEqual(Array.from(PNG));
    expect((await t.req(`/files/${fileId}?download=1`)).headers.get("Content-Disposition")).toMatch(/attachment; filename="lifeos-\d{4}-\d\d-\d\d-11\.png"/);
    const list = await (await t.req("")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].created_at).toMatch(/Z$/);

    await t.req(`/files/${fileId}`, { method: "DELETE" });
    expect((await t.req(`/files/${fileId}`)).status).toBe(404);
    await t.req(`/files/${p.item.files[1].id}`, { method: "DELETE" });
    expect((await (await t.req("")).json()).items).toHaveLength(0); // last image gone → generation gone
    expect(await t.db.prepare("SELECT COUNT(*) n FROM image_blobs").first("n")).toBe(0);
  });

  it("refuses before calling anything when the keyword guard hits", async () => {
    const t = setup();
    const r = await t.post("/generate", { text: "ロリっぽい子" });
    expect(r.status).toBe(422);
    expect((await r.json()).code).toBe("refused");
    expect(t.ai!.run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses what the AI classifies as a real person / named character", async () => {
    const t = setup({ ai: { refuse: "real_person", reason: "", tags: "", rating: "all_ages", count: null } });
    const r = await t.post("/generate", { text: "有名な俳優の肖像" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("実在");
    expect(calls.some((c) => c.url === "/v1/generate")).toBe(false);
  });

  it("checks the converted tags too, and passes the service's 422 through", async () => {
    let t = setup({ ai: { refuse: null, tags: "1girl, school uniform, nude", rating: "all_ages" } });
    expect((await t.post("/generate", { text: "女の子" })).status).toBe(422);
    t = setup();
    svc.generate = () => json({ detail: { error: "banned_term", message: "禁止語『x』を含みます" } }, 422);
    const r = await t.post("/generate", { text: "女の子" });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toContain("禁止語");
    expect((await (await t.req("")).json()).items).toHaveLength(0);
  });

  it("r18 is never inferred from the AI alone", async () => {
    const t = setup({ ai: { refuse: null, tags: "1girl, mature female", rating: "r18" } });
    await t.post("/generate", { text: "大人の女性" });
    expect(calls.find((c) => c.url === "/v1/generate")!.body.rating).toBe("all_ages");
  });

  it("AI down: Japanese is refused with a clear message, English tags go through", async () => {
    const t = setup({ ai: "down" });
    const r = await t.post("/generate", { text: "猫" });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("ai_unavailable");
    const ok = await t.post("/generate", { text: "no humans, cat, Best Quality, window" });
    expect(ok.status).toBe(201);
    expect(calls.find((c) => c.url === "/v1/generate")!.body.prompt).toBe("no humans, cat, window");
  });

  it("offline: generate says so, polling keeps the job pending, a lost job becomes an error", async () => {
    const t = setup();
    svc.down = true;
    const r = await t.post("/generate", { text: "猫" });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("offline");

    svc.down = false;
    const { item } = await (await t.post("/generate", { text: "猫" })).json();
    svc.down = true;
    const p = await (await t.req(`/jobs/${item.id}`)).json();
    expect(p).toMatchObject({ offline: true, item: { status: "queued" } });
    svc.down = false; // job unknown to the (restarted) service
    const q = await (await t.req(`/jobs/${item.id}`)).json();
    expect(q.item.status).toBe("error");
  });

  it("limits pending jobs and validates input", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) expect((await t.post("/generate", { text: "cat" })).status).toBe(201);
    expect((await t.post("/generate", { text: "cat" })).status).toBe(429);
    expect((await t.post("/generate", { text: "" })).status).toBe(400);
    expect((await t.post("/generate", { text: "cat", count: 5 })).status).toBe(400);
  });

  it("cron finishes pending jobs without the page open", async () => {
    const t = setup();
    const { item } = await (await t.post("/generate", { text: "cat" })).json();
    svc.job = () => json({ job_id: "j_1", status: "done", work_id: "w1", images: [{ filename: "c.png", seed: 5 }] });
    await syncPendingImages(t.env);
    const list = await (await t.req("")).json();
    expect(list.items[0]).toMatchObject({ id: item.id, status: "done" });
    expect(list.items[0].files).toHaveLength(1);
  });

  it("rejects unsafe file names from the service", async () => {
    const t = setup();
    const { item } = await (await t.post("/generate", { text: "cat" })).json();
    svc.job = () => json({ job_id: "j_1", status: "done", work_id: "w1", images: [{ filename: "../../etc/passwd", seed: 1 }] });
    const p = await (await t.req(`/jobs/${item.id}`)).json();
    expect(p.item.status).toBe("error");
    expect(calls.some((c) => c.url.includes("passwd"))).toBe(false);
  });
});

describe("image_input refusals from the AI", () => {
  it("ignores style words like 実写 but keeps real image-input requests", async () => {
    const { aiRefusal } = await import("../../worker/modules/images/logic");
    expect(aiRefusal("image_input", "花畑で銀髪の女子がひまわりを持って立っている。実写")).toBeNull();
    expect(aiRefusal("image_input", "写真風のリアルな夜景")).toBeNull();
    expect(aiRefusal("image_input", "この写真をアニメ風にして")).toBe("image_input");
    expect(aiRefusal("image_input", "添付の画像を元に描いて")).toBe("image_input");
    expect(aiRefusal("real_person", "実写")).toBe("real_person");
  });
});

/* ---------- photo model (RealVisXL V5.0) ---------- */

describe("photo model: guard, prompt and tags", () => {
  it("all-ages refuses sexual words (pointing to R18); r18 allows an adult request; strict about real people; anime is unchanged", () => {
    expect(guardText("a woman in a park", "r18", "photo").ok).toBe(true);
    expect(guardText("大人の女性がベッドで横になっている、ヌード", "r18", "photo").ok).toBe(true);
    expect(guardText("an adult woman, nude, 28 years old", "r18", "photo").ok).toBe(true);
    const a = guardText("R18の実写の女性", "all_ages", "photo");
    expect(a.ok).toBe(false);
    if (!a.ok) { expect(a.code).toBe("photo_adult"); expect(a.message).toContain("R18"); }
    expect(guardText("woman in lingerie", "all_ages", "photo").ok).toBe(false);
    expect(guardText("1girl, mature female, lingerie", "r18", "anime").ok).toBe(true);
    for (const t of ["芸能人の写真", "有名な女優そっくりの顔", "a celebrity on the red carpet", "a woman who looks like a famous singer", "deepfake of my boss"]) {
      const x = guardText(t, "all_ages", "photo");
      expect(x.ok, t).toBe(false);
      if (!x.ok) expect(x.code, t).toBe("real_person");
    }
    expect(guardText("a celebrity", "all_ages", "anime").ok).toBe(true); // anime keeps its own (AI) real-person check
    expect(guardText("日本人の女性がカフェで本を読んでいる", "all_ages", "photo").ok).toBe(true);
    expect(guardText("a man fixing a factor in the workshop", "all_ages", "photo").ok).toBe(true);
    expect(guardText("小学生の女の子", "all_ages", "photo").ok).toBe(false);
  });
  it("photo r18 refuses every age / youth / school word (JP and EN) and stated ages under 20", () => {
    for (const t of ["少女のヌード", "女子高生", "JKの写真", "学生の女性", "制服の女性", "ロリ", "幼い顔の女性", "若く見える女性", "小柄な女性", "童顔の女性", "10代の女性", "17歳の女性",
      "a teen woman", "teenager", "schoolgirl", "a woman in school uniform", "a petite woman", "young-looking woman", "youthful face", "a 16 years old woman", "a woman, 15yo", "high school classroom", "student"]) {
      const r = guardText(t, "r18", "photo");
      expect(r.ok, t).toBe(false);
      if (!r.ok) { expect(r.code, t).toBe("minor"); }
    }
    const r = guardText("制服の女性", "r18", "photo");
    if (!r.ok) expect(r.message).toContain("実写のR18は大人");
    expect(photoR18YouthHit("a woman, 25 years old")).toBeNull();
    expect(photoR18YouthHit("25歳の女性")).toBeNull();
    expect(photoR18YouthHit("１７歳")).toBe("17歳");
    // the same words stay fine for photo all-ages (no sexual content) and for anime
    expect(guardText("制服の女性がカフェで働いている", "all_ages", "photo").ok).toBe(true);
    expect(guardText("a woman, 25 years old, school uniform", "all_ages", "anime").ok).toBe(true);
  });
  it("photo r18 still refuses real people and lookalikes", () => {
    for (const t of ["芸能人のヌード", "女優そっくりの女性", "〇〇に似た女性", "a woman who looks like a celebrity", "deepfake nude"]) {
      const r = guardText(t, "r18", "photo");
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.code, t).toBe("real_person");
    }
  });
  it("photo r18 rewrites girl/boy to woman/man (gender kept) and drops young", () => {
    expect(photoAdultTags("1girl, solo, nude, on bed")).toBe("a woman, solo, nude, on bed");
    expect(photoAdultTags("1boy, 1girl, kissing")).toBe("a man, a woman, kissing");
    expect(photoAdultTags("2girls, girl, Girls, boy, boys")).toBe("2 women, woman, women, man, men");
    expect(photoAdultTags("a young woman lying on a bed, girlfriend")).toBe("a woman lying on a bed, girlfriend");
    expect(photoAdultTags("sunset beach")).toBe("sunset beach");
  });
  it("uses a separate conversion prompt and drops the photo-quality words the service adds", () => {
    expect(systemPromptFor("anime")).toBe(IMAGE_SYSTEM_PROMPT);
    expect(systemPromptFor("photo")).toBe(PHOTO_SYSTEM_PROMPT);
    expect(PHOTO_SYSTEM_PROMPT).toContain("RealVisXL");
    expect(PHOTO_SYSTEM_PROMPT).toContain("danbooruタグ（1girl, solo など）は使わない");
    expect(PHOTO_SYSTEM_PROMPT).toContain("\"real_person\"");
    expect(PHOTO_SYSTEM_PROMPT).toContain("「実写」「写真風」「リアル」などの画風の指定はこれに当たらない");
    expect(normalizeTags("a woman in a park, Photorealistic, RAW photo, 8k, masterpiece, soft light", "photo")).toBe("a woman in a park, soft light");
    expect(normalizeTags("1girl, realistic", "anime")).toBe("1girl, realistic");
    expect(systemPromptFor("photo", "all_ages")).toBe(PHOTO_SYSTEM_PROMPT);
    expect(systemPromptFor("photo", "r18")).toBe(PHOTO_R18_SYSTEM_PROMPT);
    expect(systemPromptFor("anime", "r18")).toBe(IMAGE_SYSTEM_PROMPT);
    expect(PHOTO_R18_SYSTEM_PROMPT).toContain("女性は \"woman\"、男性は \"man\" と書き");
    expect(PHOTO_R18_SYSTEM_PROMPT).toContain("\"girl\", \"boy\", \"1girl\"");
    expect(PHOTO_R18_SYSTEM_PROMPT).toContain("\"real_person\"");
    expect(PHOTO_R18_SYSTEM_PROMPT).toContain("女子高生・JK");
    expect(refuseMessage("adult")).toContain("R18");
  });
});

describe("photo model routes", () => {
  const photoAi = { refuse: null, reason: "", tags: "a woman in her twenties wearing a white sundress, standing in a flower field, soft sunlight, photorealistic", rating: "all_ages", count: null };
  const healthWith = (models?: Record<string, boolean>) => () => json({ ok: true, comfyui: "up", model_available: true, queue_length: 0, ...(models ? { models } : {}) });

  it("status reports which models the Mac has (older service = anime only)", async () => {
    const t = setup();
    svc.health = healthWith({ anime: true, photo: true });
    expect((await (await t.req("/status")).json()).status.models).toEqual({ anime: true, photo: true });
    svc.health = healthWith();
    expect((await (await t.req("/status")).json()).status.models).toEqual({ anime: true, photo: false });
  });

  it("generates with the photo prompt, sends model=photo and stores it; history shows the model", async () => {
    const t = setup({ ai: photoAi });
    svc.health = healthWith({ anime: true, photo: true });
    const r = await t.post("/generate", { text: "花畑で白いワンピースの女性。実写", model: "photo" });
    expect(r.status).toBe(201);
    const { item } = await r.json();
    expect(item).toMatchObject({ model: "photo", rating: "all_ages", tags: "a woman in her twenties wearing a white sundress, standing in a flower field, soft sunlight" });
    expect(calls.find((c) => c.url === "/v1/generate")!.body).toMatchObject({ model: "photo", rating: "all_ages" });
    const sys = (t.ai!.run as any).mock.calls[0][1].messages[0].content as string;
    expect(sys).toContain("RealVisXL");
    expect((await t.post("/generate", { text: "猫" })).status).toBe(201); // default stays anime
    const list = (await (await t.req("")).json()).items;
    expect(list.map((g: any) => g.model).sort()).toEqual(["anime", "photo"]);
    expect(calls.filter((c) => c.url === "/v1/generate")[1]!.body.model).toBe("anime");
  });

  it("photo r18: allowed for an adult request with rating r18, uses the r18 prompt and rewrites girl to woman", async () => {
    const t = setup({ ai: { refuse: null, reason: "", tags: "1girl, an adult woman lying on a bed, nude, soft window light", rating: "r18", count: null } });
    svc.health = healthWith({ anime: true, photo: true });
    const r = await t.post("/generate", { text: "ベッドに横たわる大人の女性、ヌード", model: "photo", rating: "r18" });
    expect(r.status).toBe(201);
    const { item } = await r.json();
    expect(item).toMatchObject({ model: "photo", rating: "r18", tags: "a woman, an adult woman lying on a bed, nude, soft window light" });
    expect(calls.find((c) => c.url === "/v1/generate")!.body).toMatchObject({ model: "photo", rating: "r18", prompt: "a woman, an adult woman lying on a bed, nude, soft window light" });
    const sys = (t.ai!.run as any).mock.calls[0][1].messages[0].content as string;
    expect(sys).toBe(PHOTO_R18_SYSTEM_PROMPT);
  });

  it("photo r18 is never inferred: adult words without rating r18 are refused, pointing to R18", async () => {
    for (const body of [{ text: "R18で大人の女性", model: "photo" }, { text: "大人の女性のヌード", model: "photo", rating: "all_ages" }]) {
      calls = [];
      const t = setup({ ai: { ...photoAi, rating: "r18" } });
      const r = await t.post("/generate", body);
      expect(r.status).toBe(422);
      expect((await r.json()).error).toContain("「R18」を選んでください");
      expect(t.ai!.run).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    }
  });

  it("photo r18 refuses youth / school / real-person words before the AI, and in the converted tags", async () => {
    for (const text of ["女子高生のヌード", "制服の女性", "若く見える小柄な女性", "17歳の女性", "a teen woman nude", "芸能人そっくりの女性"]) {
      calls = [];
      const t = setup({ ai: photoAi });
      const r = await t.post("/generate", { text, model: "photo", rating: "r18" });
      expect(r.status, text).toBe(422);
      expect(t.ai!.run).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    }
    for (const tags of ["a woman in a school uniform, nude", "a teenage woman", "a woman who looks like a celebrity"]) {
      calls = [];
      const t = setup({ ai: { refuse: null, reason: "", tags, rating: "r18", count: null } });
      svc.health = healthWith({ anime: true, photo: true });
      expect((await t.post("/generate", { text: "大人の女性", model: "photo", rating: "r18" })).status, tags).toBe(422);
      expect(calls.some((c) => c.url === "/v1/generate")).toBe(false);
    }
    const t = setup({ ai: { refuse: "minor", reason: "", tags: "", rating: "r18", count: null } });
    expect((await t.post("/generate", { text: "あどけない女性", model: "photo", rating: "r18" })).status).toBe(422);
  });

  it("refuses the AI's adult verdict and real-person words in the converted text", async () => {
    let t = setup({ ai: { refuse: "adult", reason: "", tags: "", rating: "all_ages", count: null } });
    expect((await (await t.post("/generate", { text: "きわどい水着の女性", model: "photo" })).json()).error).toContain("R18");
    t = setup({ ai: { ...photoAi, tags: "a celebrity smiling" } });
    svc.health = healthWith({ anime: true, photo: true });
    expect((await t.post("/generate", { text: "笑顔の女性", model: "photo" })).status).toBe(422);
    expect(calls.some((c) => c.url === "/v1/generate")).toBe(false);
  });

  it("says the photo model is missing instead of letting an older service draw anime", async () => {
    const t = setup({ ai: photoAi });
    svc.health = healthWith(); // service without `models`
    const r = await t.post("/generate", { text: "花畑の女性", model: "photo" });
    expect(r.status).toBe(503);
    const b = await r.json();
    expect(b.code).toBe("model_unavailable");
    expect(b.error).toContain("セットアップをもう一度実行");
    expect(calls.some((c) => c.url === "/v1/generate")).toBe(false);
    svc.health = healthWith({ anime: true, photo: false });
    expect((await t.post("/generate", { text: "花畑の女性", model: "photo" })).status).toBe(503);
    expect((await t.post("/generate", { text: "花畑の女性", model: "oil" })).status).toBe(400);
  });

  it("migration 0015 adds model, defaulting existing rows to anime", async () => {
    const db = new D1Shim(":memory:");
    migrate(db, [{ name: "0014_images.sql", sql: readFileSync("migrations/0014_images.sql", "utf8") }]);
    await db.prepare("INSERT INTO image_generations (id,user_id,prompt_text,tags) VALUES ('g1','u1','猫','cat')").run();
    migrate(db, [{ name: "0015_image_generation_model.sql", sql: readFileSync("migrations/0015_image_generation_model.sql", "utf8") }]);
    expect(await db.prepare("SELECT model FROM image_generations WHERE id='g1'").first("model")).toBe("anime");
    expect(readdirSync("migrations").filter((f) => f.startsWith("0015_"))).toEqual(["0015_image_generation_model.sql"]);
  });
});
