import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId } from "../../core/db";
import { chatJson } from "../../core/ai";
import { IMAGE_COUNT_MAX, IMAGE_RATINGS, type ImageFile, type ImageGeneration, type ImageRating, type ImageServiceStatus } from "../../../shared/images";
import { IMAGE_SYSTEM_PROMPT, SAFE_NAME, clampCount, decideRating, guardText, looksLikeTags, normalizeTags, parseConversion, refuseMessage, serviceError } from "./logic";

/**
 * 画像生成. Talks to the Mac imggen service (IMGGEN_URL, bearer IMGGEN_TOKEN — never sent to the browser).
 * Finished images are copied into server storage right away, so the gallery keeps working while the Mac sleeps.
 */
export const routes = new Hono<AppEnv>();

const MAX_PENDING = 3;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type GenRow = { id: string; user_id: string; prompt_text: string; tags: string; rating: string; count: number; seed: number | null; job_id: string | null; status: string; progress_done: number; queue_position: number | null; work_id: string | null; error: string | null; created_at: string; updated_at: string };
type FileRow = { id: string; generation_id: string; idx: number; filename: string; seed: number | null; bytes: number; mime: string; store_key: string; created_at: string };

/* ---------- service client ---------- */

export class ServiceOffline extends Error {}
const configured = (env: Env) => Boolean(env.IMGGEN_URL && env.IMGGEN_TOKEN);
/** Calls the service. Network failures / timeouts become ServiceOffline (the Mac is asleep or the tunnel is down). */
async function svc(env: Env, path: string, init: RequestInit = {}, timeoutMs = 6000): Promise<Response> {
  if (!configured(env)) throw new ServiceOffline("unconfigured");
  const base = env.IMGGEN_URL!.replace(/\/+$/, "");
  try {
    return await fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${env.IMGGEN_TOKEN}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) { throw new ServiceOffline(String(e)); }
}
const readJson = async (r: Response): Promise<unknown> => { try { return await r.json(); } catch { return null; } };

const OFFLINE_MESSAGE = "Macに接続できません。Macが起動していないか、スリープ中です。";

export async function serviceStatus(env: Env): Promise<ImageServiceStatus> {
  const base: ImageServiceStatus = { state: "offline", message: OFFLINE_MESSAGE, comfyui: null, model_available: null, queue_length: null };
  if (!configured(env)) return { ...base, state: "unconfigured", message: "画像生成サービスの接続先が設定されていません。" };
  let r: Response;
  try { r = await svc(env, "/v1/health", {}, 5000); } catch { return base; }
  if (r.status === 401 || r.status === 403) return { ...base, message: "画像生成サービスの認証に失敗しました。" };
  const b = (await readJson(r)) as { ok?: boolean; comfyui?: string; model_available?: boolean; queue_length?: number } | null;
  const detail = { comfyui: b?.comfyui === "up" ? "up" as const : b?.comfyui === "down" ? "down" as const : null, model_available: typeof b?.model_available === "boolean" ? b.model_available : null, queue_length: typeof b?.queue_length === "number" ? b.queue_length : null };
  if (r.ok && b?.ok) return { state: "online", message: null, ...detail };
  return { state: "offline", message: b?.model_available === false ? "Macのモデルが準備できていません（SSDが未接続の可能性）。" : "画像生成サービスが応答しません。", ...detail };
}

/* ---------- storage ---------- */

function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return null;
}
export const store = {
  async get(env: Env, key: string) {
    if (env.IMAGE_STORE) return env.IMAGE_STORE.get(key);
    const row = await one<{ data: unknown }>(env.DB, "SELECT data FROM image_blobs WHERE key=?", key);
    return row ? toBytes(row.data) : null;
  },
  async put(env: Env, key: string, bytes: Uint8Array) {
    if (env.IMAGE_STORE) return env.IMAGE_STORE.put(key, bytes);
    await run(env.DB, "INSERT INTO image_blobs (key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data", key, bytes);
  },
  async delete(env: Env, key: string) {
    if (env.IMAGE_STORE) return env.IMAGE_STORE.delete(key);
    await run(env.DB, "DELETE FROM image_blobs WHERE key=?", key);
  },
};

/* ---------- rows ---------- */

const GEN_COLS = "id,user_id,prompt_text,tags,rating,count,seed,job_id,status,progress_done,queue_position,work_id,error,created_at,updated_at";
/** SQLite datetime('now') is UTC without a zone ("2026-10-24 01:02:03"); the browser needs ISO to show JST. */
const iso = (t: string) => (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(t) ? `${t.replace(" ", "T")}Z` : t);
const toFile = (f: FileRow): ImageFile => ({ id: f.id, idx: f.idx, filename: f.filename, seed: f.seed, bytes: f.bytes, created_at: iso(f.created_at) });
const toItem = (g: GenRow, files: FileRow[]): ImageGeneration => ({
  id: g.id, prompt_text: g.prompt_text, tags: g.tags, rating: (g.rating === "r18" ? "r18" : "all_ages"), count: g.count, seed: g.seed,
  status: g.status as ImageGeneration["status"], progress_done: g.progress_done, queue_position: g.queue_position, error: g.error,
  created_at: iso(g.created_at), updated_at: iso(g.updated_at), files: files.filter((f) => f.generation_id === g.id).sort((a, b) => a.idx - b.idx).map(toFile),
});
const getGen = (env: Env, id: string, userId: string) => one<GenRow>(env.DB, `SELECT ${GEN_COLS} FROM image_generations WHERE id=? AND user_id=?`, id, userId);
async function itemOf(env: Env, g: GenRow) {
  return toItem(g, await all<FileRow>(env.DB, "SELECT * FROM image_files WHERE generation_id=?", g.id));
}
const setGen = (env: Env, id: string, sets: Record<string, unknown>) => {
  const keys = Object.keys(sets);
  return run(env.DB, `UPDATE image_generations SET ${keys.map((k) => `${k}=?`).join(", ")}, updated_at=datetime('now') WHERE id=?`, ...keys.map((k) => sets[k]), id);
};

/**
 * Brings one pending generation up to date with the service. On "done" it downloads every image into storage
 * before marking the row done (so a half-copied job is retried on the next poll). Returns false when the Mac
 * could not be reached (the row is left as it was).
 */
export async function refreshGeneration(env: Env, g: GenRow): Promise<boolean> {
  if ((g.status !== "queued" && g.status !== "running") || !g.job_id) return true;
  let r: Response;
  try { r = await svc(env, `/v1/jobs/${encodeURIComponent(g.job_id)}`); } catch { return false; }
  if (r.status === 404) { await setGen(env, g.id, { status: "error", error: "Mac側でジョブが見つかりません（Macの再起動などで失われました）。" }); return true; }
  if (!r.ok) return false;
  const j = (await readJson(r)) as { status?: string; done?: number; total?: number; work_id?: string; error?: string; message?: string; images?: { filename?: string; seed?: number | null; bytes?: number; sha256?: string | null }[] } | null;
  if (!j?.status) return false;
  if (j.status === "queued") return true;
  if (j.status === "running") { if (typeof j.done === "number" && j.done !== g.progress_done) await setGen(env, g.id, { status: "running", progress_done: j.done, queue_position: null }); else if (g.status !== "running") await setGen(env, g.id, { status: "running", queue_position: null }); return true; }
  if (j.status === "error") { await setGen(env, g.id, { status: "error", error: (j.message || "生成に失敗しました。").slice(0, 500) }); return true; }
  if (j.status !== "done") return true;

  const workId = String(j.work_id ?? "");
  const images = Array.isArray(j.images) ? j.images : [];
  if (!SAFE_NAME.test(workId)) { await setGen(env, g.id, { status: "error", error: "サービスの応答が不正です。" }); return true; }
  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx]!;
    const filename = String(img.filename ?? "");
    if (!SAFE_NAME.test(filename) || !filename.endsWith(".png")) continue;
    if (await one(env.DB, "SELECT 1 FROM image_files WHERE generation_id=? AND idx=?", g.id, idx)) continue;
    let ir: Response;
    try { ir = await svc(env, `/v1/images/${workId}/${filename}`, {}, 60_000); } catch { return false; }
    if (!ir.ok) { if (ir.status === 404) continue; return false; }
    const bytes = new Uint8Array(await ir.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue;
    const key = `${g.user_id}/${g.id}/${idx}.png`;
    await store.put(env, key, bytes);
    await run(env.DB, "INSERT OR IGNORE INTO image_files (id,generation_id,user_id,idx,filename,seed,bytes,sha256,mime,store_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
      newId(), g.id, g.user_id, idx, filename, typeof img.seed === "number" ? img.seed : null, bytes.length, img.sha256 ?? null, "image/png", key);
  }
  const n = (await one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM image_files WHERE generation_id=?", g.id))?.n ?? 0;
  await setGen(env, g.id, n > 0
    ? { status: "done", work_id: workId, progress_done: n, queue_position: null, error: null }
    : { status: "error", work_id: workId, error: "画像を受け取れませんでした。" });
  return true;
}

/** Cron (every 10 min): finish jobs whose page was closed, so their images are saved before the service forgets them (1 h). */
export async function syncPendingImages(env: Env) {
  if (!configured(env)) return;
  const rows = await all<GenRow>(env.DB, `SELECT ${GEN_COLS} FROM image_generations WHERE status IN ('queued','running') ORDER BY created_at LIMIT 10`);
  for (const g of rows) if (!(await refreshGeneration(env, g))) break; // Mac offline → try again next time
}

/* ---------- routes ---------- */

routes.get("/status", async (c) => c.json({ status: await serviceStatus(c.env) }));

routes.get("/", async (c) => {
  const user = c.get("user");
  const gens = await all<GenRow>(c.env.DB, `SELECT ${GEN_COLS} FROM image_generations WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200`, user.id);
  const files = gens.length ? await all<FileRow>(c.env.DB, `SELECT * FROM image_files WHERE user_id=? AND generation_id IN (${gens.map(() => "?").join(",")})`, user.id, ...gens.map((g) => g.id)) : [];
  return c.json({ items: gens.map((g) => toItem(g, files)) });
});

const genSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  count: z.number().int().min(1).max(IMAGE_COUNT_MAX).optional(),
  rating: z.enum(IMAGE_RATINGS).optional(),
  seed: z.number().int().min(0).max(2 ** 32 - 1).nullable().optional(),
});

/** Converts the user's words to tags (AI) and applies the §0 guard on both sides of the conversion. */
export async function prepareRequest(env: Env, body: z.infer<typeof genSchema>): Promise<{ ok: true; tags: string; rating: ImageRating; count: number } | { ok: false; status: 422 | 503; code: string; message: string }> {
  const pre = guardText(body.text, body.rating === "r18" ? "r18" : "all_ages");
  if (!pre.ok) return { ok: false, status: 422, code: "refused", message: pre.message };
  const fallback = { refuse: "__fallback", reason: "", tags: "", rating: "all_ages", count: null };
  const ai = await chatJson<unknown>(env, [{ role: "system", content: IMAGE_SYSTEM_PROMPT }, { role: "user", content: body.text }], fallback);
  let conv = ai.parsed ? parseConversion(ai.data) : null;
  if (!conv) {
    // AI down or unparseable: only English tags typed by the user can go through (keyword guard + service guard).
    if (!looksLikeTags(body.text)) return { ok: false, status: 503, code: "ai_unavailable", message: "AIに接続できないため日本語を変換できません。英語のタグで入力すると生成できます。" };
    conv = { refuse: null, reason: "", tags: normalizeTags(body.text), rating: "all_ages", count: null };
  }
  if (conv.refuse) return { ok: false, status: 422, code: "refused", message: refuseMessage(conv.refuse, conv.reason) };
  if (!conv.tags) return { ok: false, status: 422, code: "empty", message: "画像の内容を読み取れませんでした。もう少し具体的に書いてください。" };
  const rating = decideRating(body.rating, conv.rating, body.text);
  const post = guardText(conv.tags, rating);
  if (!post.ok) return { ok: false, status: 422, code: "refused", message: post.message };
  return { ok: true, tags: conv.tags, rating, count: body.count ?? conv.count ?? 1 };
}

routes.post("/generate", async (c) => {
  const user = c.get("user");
  const body = genSchema.parse(await c.req.json());
  if (!configured(c.env)) return c.json({ error: "画像生成サービスの接続先が設定されていません。", code: "unconfigured" }, 503);
  const pending = (await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM image_generations WHERE user_id=? AND status IN ('queued','running')", user.id))?.n ?? 0;
  if (pending >= MAX_PENDING) return c.json({ error: `生成待ちが${MAX_PENDING}件あります。終わってから追加してください。`, code: "busy" }, 429);

  const prep = await prepareRequest(c.env, body);
  if (!prep.ok) return c.json({ error: prep.message, code: prep.code }, prep.status);
  const count = clampCount(prep.count);
  const payload: Record<string, unknown> = { prompt: prep.tags, count, rating: prep.rating, title: "", requester: `lifeos:${user.id}` };
  if (body.seed != null) payload.seed = body.seed;

  let r: Response;
  try { r = await svc(c.env, "/v1/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, 15_000); }
  catch { return c.json({ error: OFFLINE_MESSAGE, code: "offline" }, 503); }
  const resBody = await readJson(r);
  if (r.status === 422) { const e = serviceError(resBody); return c.json({ error: e.message || "このプロンプトは生成できません。", code: "refused", tags: prep.tags }, 422); }
  if (r.status === 401 || r.status === 403) return c.json({ error: "画像生成サービスの認証に失敗しました。", code: "offline" }, 503);
  if (r.status === 503) { const e = serviceError(resBody); return c.json({ error: e.message || "今は画像生成できません。", code: "offline" }, 503); }
  const jobId = (resBody as { job_id?: unknown } | null)?.job_id;
  if (!r.ok || typeof jobId !== "string") return c.json({ error: "画像生成サービスがエラーを返しました。", code: "service_error" }, 502);

  const id = newId();
  const qp = (resBody as { queue_position?: unknown }).queue_position;
  await run(c.env.DB, "INSERT INTO image_generations (id,user_id,prompt_text,tags,rating,count,seed,job_id,status,queue_position) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, user.id, body.text, prep.tags, prep.rating, count, body.seed ?? null, jobId, "queued", typeof qp === "number" ? qp : null);
  return c.json({ item: await itemOf(c.env, (await getGen(c.env, id, user.id))!) }, 201);
});

routes.get("/jobs/:id", async (c) => {
  const user = c.get("user");
  const g = await getGen(c.env, c.req.param("id"), user.id);
  if (!g) return c.json({ error: "not found" }, 404);
  const reached = await refreshGeneration(c.env, g);
  return c.json({ item: await itemOf(c.env, (await getGen(c.env, g.id, user.id))!), offline: !reached });
});

routes.get("/files/:id", async (c) => {
  const user = c.get("user");
  const f = await one<FileRow & { gen_created: string }>(c.env.DB, "SELECT f.*, g.created_at gen_created FROM image_files f JOIN image_generations g ON g.id=f.generation_id WHERE f.id=? AND f.user_id=?", c.req.param("id"), user.id);
  if (!f) return c.json({ error: "not found" }, 404);
  const bytes = await store.get(c.env, f.store_key);
  if (!bytes) return c.json({ error: "画像データが見つかりません。" }, 404);
  const headers: Record<string, string> = { "Content-Type": f.mime || "image/png", "Cache-Control": "private, max-age=31536000, immutable", "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff" };
  if (c.req.query("download")) headers["Content-Disposition"] = `attachment; filename="lifeos-${f.gen_created.slice(0, 10)}-${f.seed ?? f.idx}.png"`;
  return new Response(bytes, { headers });
});

routes.delete("/files/:id", async (c) => {
  const user = c.get("user");
  const f = await one<FileRow>(c.env.DB, "SELECT * FROM image_files WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  if (!f) return c.json({ ok: true });
  await store.delete(c.env, f.store_key);
  await run(c.env.DB, "DELETE FROM image_files WHERE id=?", f.id);
  const left = (await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM image_files WHERE generation_id=?", f.generation_id))?.n ?? 0;
  if (!left) await run(c.env.DB, "DELETE FROM image_generations WHERE id=? AND user_id=? AND status='done'", f.generation_id, user.id);
  return c.json({ ok: true });
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  const g = await getGen(c.env, c.req.param("id"), user.id);
  if (!g) return c.json({ ok: true });
  for (const f of await all<FileRow>(c.env.DB, "SELECT * FROM image_files WHERE generation_id=?", g.id)) await store.delete(c.env, f.store_key);
  await run(c.env.DB, "DELETE FROM image_files WHERE generation_id=?", g.id);
  await run(c.env.DB, "DELETE FROM image_generations WHERE id=? AND user_id=?", g.id, user.id);
  return c.json({ ok: true });
});
