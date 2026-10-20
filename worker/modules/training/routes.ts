import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, nowIso } from "../../core/db";
import { notify } from "../../core/notify";
import { CATALOG, PARTS, getExercise, canonicalKey, legacyKeysFor, searchCatalog, unitFor, type CatalogEntry, type TrainingSession, type TrainingSet, type ExerciseRecord, type Part, type Equipment, EQUIPMENTS } from "../../../shared/training";
import { pickBest, progressionAdvice, summarizeSession, type Advice } from "./logic";
import { parseTrainingText, type ParsedAction } from "./nlp";

export const routes = new Hono<AppEnv>();

const partSchema = z.enum(PARTS);
const unitSchema = z.enum(["total", "per_hand", "plate", "bodyweight", "time"]);
const setBody = z.object({
  exercise_key: z.string().min(1).max(64),
  weight: z.number().finite().nonnegative().nullable().optional(),
  reps: z.number().int().min(0).max(1000).nullable().optional(),
  duration_sec: z.number().int().min(0).max(86400).nullable().optional(),
  unit: unitSchema.optional(),
  memo: z.string().max(500).nullable().optional(),
});

const nameOf = (key: string) => getExercise(key)?.name ?? key;

async function getSession(env: Env, userId: string, id: string) {
  return one<TrainingSession>(env.DB, "SELECT id,part,started_at,ended_at,notes FROM training_sessions WHERE id=? AND user_id=?", id, userId);
}
async function activeSession(env: Env, userId: string) {
  return one<TrainingSession>(env.DB, "SELECT id,part,started_at,ended_at,notes FROM training_sessions WHERE user_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1", userId);
}
async function sessionSets(env: Env, userId: string, sessionId: string) {
  return all<TrainingSet>(env.DB, "SELECT id,session_id,exercise_key,weight,reps,duration_sec,unit,memo,created_at FROM training_sets WHERE session_id=? AND user_id=? ORDER BY created_at, rowid", sessionId, userId);
}
async function exerciseHistory(env: Env, userId: string, key: string, limit = 200) {
  const keys = [key, ...legacyKeysFor(key)];
  const placeholders = keys.map(() => "?").join(",");
  return all<TrainingSet & { started_at: string; part: string }>(env.DB,
    `SELECT s.id,s.session_id,s.exercise_key,s.weight,s.reps,s.duration_sec,s.unit,s.memo,s.created_at,ss.started_at,ss.part
     FROM training_sets s JOIN training_sessions ss ON ss.id=s.session_id
     WHERE s.user_id=? AND s.exercise_key IN (${placeholders}) ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`, userId, ...keys, limit);
}

async function startSession(env: Env, userId: string, part: Part) {
  const existing = await activeSession(env, userId);
  if (existing) return { session: existing, created: false };
  const id = newId();
  await run(env.DB, "INSERT INTO training_sessions (id,user_id,part,started_at) VALUES (?,?,?,?)", id, userId, part, nowIso());
  return { session: (await getSession(env, userId, id))!, created: true };
}

async function addSet(env: Env, userId: string, sessionId: string, body: z.infer<typeof setBody>) {
  const key = canonicalKey(body.exercise_key);
  const entry = getExercise(key);
  const unit = body.unit ?? (entry ? unitFor(entry) : null);
  const isTime = unit === "time", isBw = unit === "bodyweight";
  const weight = isTime || isBw ? null : body.weight ?? null;
  const reps = isTime ? null : body.reps ?? null;
  const duration = isTime ? body.duration_sec ?? null : null;
  if (isTime && duration == null) throw new Error("duration_sec required");
  if (!isTime && reps == null) throw new Error("reps required");
  const id = newId();
  await run(env.DB, "INSERT INTO training_sets (id,session_id,user_id,exercise_key,weight,reps,duration_sec,unit,memo,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, sessionId, userId, key, weight, reps, duration, unit, body.memo ?? null, nowIso());
  return (await one<TrainingSet>(env.DB, "SELECT id,session_id,exercise_key,weight,reps,duration_sec,unit,memo,created_at FROM training_sets WHERE id=?", id))!;
}

async function finishSession(env: Env, userId: string, session: TrainingSession) {
  const ended = nowIso();
  if (!session.ended_at) await run(env.DB, "UPDATE training_sessions SET ended_at=? WHERE id=? AND user_id=?", ended, session.id, userId);
  const sets = await sessionSets(env, userId, session.id);
  const mins = Math.max(0, Math.round((new Date(ended).getTime() - new Date(session.started_at).getTime()) / 60000));
  const summary = summarizeSession(sets, nameOf, mins);
  await notify(env, userId, { kind: "training", title: `トレーニング終了：${session.part}`, body: summary, url: `/training/history/${session.id}`, dedupeKey: `training:finish:${session.id}` });
  return { session: { ...session, ended_at: session.ended_at ?? ended }, sets, summary };
}

async function adviceFor(env: Env, userId: string, key: string): Promise<{ entry: CatalogEntry; advice: Advice; last: TrainingSet[] }> {
  const entry = getExercise(key);
  if (!entry) throw new Error("unknown exercise");
  const history = await exerciseHistory(env, userId, entry.key, 60);
  return { entry, advice: progressionAdvice(history, entry), last: history.slice(0, 8) };
}

/* ---------- Catalog ---------- */
routes.get("/catalog", (c) => {
  const q = c.req.query("q") ?? "";
  const part = c.req.query("part") as Part | undefined;
  const equipment = c.req.query("equipment") as Equipment | undefined;
  const items = searchCatalog(q, { part: part && PARTS.includes(part) ? part : "", equipment: equipment && EQUIPMENTS.includes(equipment) ? equipment : "" });
  return c.json({ items, total: CATALOG.length, parts: PARTS });
});

/* ---------- Sessions ---------- */
routes.get("/active", async (c) => {
  const user = c.get("user");
  const session = await activeSession(c.env, user.id);
  if (!session) return c.json({ session: null, sets: [] });
  return c.json({ session, sets: await sessionSets(c.env, user.id, session.id) });
});

routes.post("/sessions", async (c) => {
  const user = c.get("user");
  const body = z.object({ part: partSchema }).parse(await c.req.json());
  const { session, created } = await startSession(c.env, user.id, body.part);
  return c.json({ session, created }, created ? 201 : 200);
});

routes.get("/sessions", async (c) => {
  const user = c.get("user");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
  const items = await all<TrainingSession>(c.env.DB,
    `SELECT s.id,s.part,s.started_at,s.ended_at,s.notes,(SELECT COUNT(*) FROM training_sets t WHERE t.session_id=s.id) set_count
     FROM training_sessions s WHERE s.user_id=? ORDER BY s.started_at DESC LIMIT ?`, user.id, limit);
  return c.json({ items });
});

routes.get("/sessions/:id", async (c) => {
  const user = c.get("user");
  const session = await getSession(c.env, user.id, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json({ session, sets: await sessionSets(c.env, user.id, session.id) });
});

routes.post("/sessions/:id/sets", async (c) => {
  const user = c.get("user");
  const session = await getSession(c.env, user.id, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  const body = setBody.parse(await c.req.json());
  if (!getExercise(body.exercise_key)) return c.json({ error: "unknown exercise" }, 400);
  try { return c.json({ set: await addSet(c.env, user.id, session.id, body) }, 201); }
  catch (e) { return c.json({ error: String((e as Error).message) }, 400); }
});

routes.delete("/sets/:id", async (c) => {
  const user = c.get("user");
  const r = await run(c.env.DB, "DELETE FROM training_sets WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true, deleted: r.meta.changes ?? 0 });
});

routes.post("/sessions/:id/finish", async (c) => {
  const user = c.get("user");
  const session = await getSession(c.env, user.id, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(await finishSession(c.env, user.id, session));
});

routes.delete("/sessions/:id", async (c) => {
  const user = c.get("user");
  const session = await getSession(c.env, user.id, c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "DELETE FROM training_sets WHERE session_id=? AND user_id=?", session.id, user.id);
  await run(c.env.DB, "DELETE FROM training_sessions WHERE id=? AND user_id=?", session.id, user.id);
  return c.json({ ok: true });
});

/* ---------- Records / history / advice ---------- */
routes.get("/records", async (c) => {
  const user = c.get("user");
  const rows = await all<TrainingSet>(c.env.DB, "SELECT id,session_id,exercise_key,weight,reps,duration_sec,unit,memo,created_at FROM training_sets WHERE user_id=? ORDER BY created_at", user.id);
  const groups = new Map<string, TrainingSet[]>();
  for (const r of rows) { const k = canonicalKey(r.exercise_key); const arr = groups.get(k) ?? []; arr.push(r); groups.set(k, arr); }
  const items: ExerciseRecord[] = [];
  for (const [key, sets] of groups) {
    const entry = getExercise(key);
    const { best, est_1rm } = pickBest(sets);
    items.push({
      exercise_key: key, name: entry?.name ?? key, unit: best?.unit ?? (entry ? unitFor(entry) : null), measurement: entry?.measurement ?? "reps",
      best: best ? { weight: best.weight, reps: best.reps, duration_sec: best.duration_sec, created_at: best.created_at, session_id: best.session_id } : null,
      est_1rm, set_count: sets.length,
    });
  }
  items.sort((a, b) => (b.est_1rm?.value ?? -1) - (a.est_1rm?.value ?? -1) || a.name.localeCompare(b.name, "ja"));
  return c.json({ items });
});

routes.get("/exercises/:key/history", async (c) => {
  const user = c.get("user");
  const key = canonicalKey(c.req.param("key"));
  const entry = getExercise(key);
  if (!entry) return c.json({ error: "unknown exercise" }, 404);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
  const sets = await exerciseHistory(c.env, user.id, key, limit);
  const { best, est_1rm } = pickBest(sets);
  return c.json({ entry, sets, best, est_1rm });
});

routes.get("/advice/:key", async (c) => {
  const user = c.get("user");
  try { return c.json(await adviceFor(c.env, user.id, canonicalKey(c.req.param("key")))); }
  catch { return c.json({ error: "unknown exercise" }, 404); }
});

/* ---------- Natural text (Discord) ---------- */
export type LogResult = { action: ParsedAction["type"]; ok: boolean; message: string; session?: TrainingSession | null; set?: TrainingSet; advice?: Advice };

/**
 * Apply one line of Japanese natural text ("ベンチプレス 60kg 8回", "スクワット開始", "終了", "ベンチプレス 次の重量") to the user's training log.
 * A set logged with no open session starts one automatically (part inferred from the exercise).
 */
export async function logFromText(env: Env, userId: string, text: string): Promise<LogResult> {
  const parsed = parseTrainingText(text);
  switch (parsed.type) {
    case "finish": {
      const session = await activeSession(env, userId);
      if (!session) return { action: "finish", ok: false, message: "進行中のセッションはありません。", session: null };
      const r = await finishSession(env, userId, session);
      return { action: "finish", ok: true, message: `トレーニングを終了しました（${session.part}）。\n${r.summary}`, session: r.session };
    }
    case "start": {
      const part = parsed.part ?? "その他";
      const { session, created } = await startSession(env, userId, part);
      return { action: "start", ok: true, session, message: created ? `${session.part}のトレーニングを開始しました。` : `すでに${session.part}のセッションが進行中です。` };
    }
    case "advice": {
      const { advice } = await adviceFor(env, userId, parsed.exercise.key);
      return { action: "advice", ok: true, advice, message: advice.message };
    }
    case "set": {
      const { session } = await startSession(env, userId, parsed.exercise.part);
      let last: TrainingSet | undefined;
      for (let i = 0; i < parsed.sets; i++) {
        last = await addSet(env, userId, session.id, { exercise_key: parsed.exercise.key, weight: parsed.weight, reps: parsed.reps, duration_sec: parsed.duration_sec, memo: parsed.memo });
      }
      const desc = parsed.duration_sec != null ? `${parsed.duration_sec}秒` : parsed.weight != null ? `${parsed.weight}kg × ${parsed.reps}回` : `${parsed.reps}回`;
      return { action: "set", ok: true, session, set: last, message: `${parsed.exercise.name} ${desc}${parsed.sets > 1 ? ` × ${parsed.sets}セット` : ""} を記録しました。` };
    }
    default:
      return { action: "unknown", ok: false, message: "読み取れませんでした。例：「ベンチプレス 60kg 8回」「胸トレ開始」「終了」" };
  }
}
