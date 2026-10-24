import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import type { WeatherLocation } from "../../../shared/types";
import { all, one, run, newId, getSetting, setSetting, jstDate, kvPutSafe } from "../../core/db";
import { chatJson } from "../../core/ai";
import { adviseWithContext, buildLifeContext, suggestAction } from "../../core/context";
import { fetchWeather, type WeatherSnapshot } from "../../core/weather";
import { syncOura } from "./oura";
import { mealRoutes, dayLog } from "./meals";
import { lookupFood } from "./food-table";
import { NUTRIENT_KEYS, summarizeNutrition, estimateCost, computePersonalThreshold, parseNutrition, normalizeMealProposal, scaleNutrition, type Nutrition, type NutrientKey } from "./logic";

export const routes = new Hono<AppEnv>();

/* ---------- helpers ---------- */
async function weatherCached(env: Env, userId: string): Promise<WeatherSnapshot | null> {
  const loc = await getSetting<WeatherLocation | null>(env, userId, "weather_location", null);
  if (!loc) return null;
  const key = `weather:${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  try {
    const cached = (await env.KV.get(key, "json")) as WeatherSnapshot | null;
    if (cached?.pressure_series) return cached;
    const w = await fetchWeather(loc);
    await kvPutSafe(env, key, JSON.stringify(w), { expirationTtl: 600 });
    return w;
  } catch { return null; }
}
/** |delta3h| for every hour in the series that has 3 preceding readings → baseline distribution. */
function baselineAbsDeltas(series: { hpa: number | null }[]): number[] {
  const out: number[] = [];
  for (let i = 3; i < series.length; i++) { const a = series[i].hpa, b = series[i - 3].hpa; if (a != null && b != null) out.push(Math.abs(a - b)); }
  return out;
}
const nutritionSchema = z.record(z.string(), z.number().nullable()).transform((r) => {
  const out: Nutrition = {};
  for (const k of NUTRIENT_KEYS) { const v = r[k]; if (typeof v === "number" && Number.isFinite(v)) out[k] = v; }
  return out;
});

/* ---------- Overview ---------- */
routes.get("/overview", async (c) => {
  const user = c.get("user");
  const today = jstDate();
  const since = new Date(Date.now() + 9 * 3600e3 - 13 * 86400e3).toISOString().slice(0, 10);
  const [latest, series, weather, ctx, logs] = await Promise.all([
    one(c.env.DB, "SELECT day,sleep_duration_sec,sleep_score,readiness_score,steps,hrv,resting_hr,sleep_balance,synced_at FROM oura_daily WHERE user_id=? ORDER BY day DESC LIMIT 1", user.id),
    all(c.env.DB, "SELECT day,sleep_duration_sec,sleep_score,readiness_score,steps,hrv,resting_hr,sleep_balance FROM oura_daily WHERE user_id=? AND day>=? ORDER BY day", user.id, since),
    weatherCached(c.env, user.id),
    buildLifeContext(c.env, user.id),
    all(c.env.DB, "SELECT id,logged_at,symptom,severity,pressure_hpa,delta3h,delta6h FROM pressure_logs WHERE user_id=? AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 30", user.id),
  ]);
  ctx.health.pressure = weather?.pressure ?? null;
  const allLogs = await all<{ delta3h: number | null }>(c.env.DB, "SELECT delta3h FROM pressure_logs WHERE user_id=? AND deleted_at IS NULL", user.id);
  const personal = computePersonalThreshold(allLogs, weather ? baselineAbsDeltas(weather.pressure_series) : []);
  const hasToken = Boolean(c.env.OURA_ACCESS_TOKEN) || Boolean(await one(c.env.DB, "SELECT 1 FROM integration_tokens WHERE user_id=? AND provider='oura'", user.id));
  return c.json({
    today,
    oura: latest ? { ...latest, is_today: latest.day === today } : null,
    oura_configured: hasToken,
    series,
    weather: weather ? { location: weather.location, pressure: weather.pressure, fetched_at: weather.fetched_at, series: weather.pressure_series.slice(-36) } : null,
    weather_configured: Boolean(weather) || Boolean(await getSetting<WeatherLocation | null>(c.env, user.id, "weather_location", null)),
    suggestion: suggestAction(ctx),
    activity: ctx.health.activity,
    pressure_logs: logs,
    personal,
  });
});

routes.post("/oura/sync", async (c) => {
  const user = c.get("user");
  try { return c.json({ ok: true, ...(await syncOura(c.env, user.id)) }); }
  catch (e) { return c.json({ ok: false, error: String((e as Error)?.message ?? e) }, 502); }
});

/* ---------- Meals: daily log, saved foods, sets (meals.ts) ---------- */
routes.route("/meals", mealRoutes);

/* ---------- Meals: legacy routine rows (now set members) ---------- */
const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
const mealBody = z.object({
  slot: z.enum(SLOTS), food_name: z.string().min(1).max(120), amount: z.number().nullable().optional(), unit: z.string().max(20).nullable().optional(),
  nutrition: nutritionSchema.nullable().optional(), cost_per_serving: z.number().min(0).nullable().optional(), sort_order: z.number().int().optional(),
});
type MealRow = { id: string; slot: string; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null; sort_order: number; updated_at: string };
const mealOut = (m: MealRow) => ({ ...m, nutrition: parseNutrition(m.nutrition_json) });

/** Today's eaten log (not the saved sets) is what the AI and the summary endpoints report on. */
async function mealSummary(env: Env, userId: string) {
  const { summary } = await dayLog(env, userId, jstDate());
  return summary;
}
routes.get("/meals/summary", async (c) => c.json(await mealSummary(c.env, c.get("user").id)));

/** Estimate the nutrition of a logged entry or a saved food with the AI. Recorded values need `confirm`. */
type Estimable = { id: string; name: string; amount: number | null; unit: string | null; nutrition_source: string | null };
async function loadEstimable(env: Env, userId: string, kind: "entry" | "food", id: string): Promise<Estimable | null> {
  if (kind === "food") {
    const f = await one<{ id: string; name: string; amount: number | null; unit: string | null; nutrition_source: string | null }>(env.DB, "SELECT id,name,amount,unit,nutrition_source FROM meal_foods WHERE id=? AND user_id=?", id, userId);
    return f ?? null;
  }
  const e = await one<{ id: string; food_name: string; amount: number | null; unit: string | null; nutrition_source: string | null }>(env.DB, "SELECT id,food_name,amount,unit,nutrition_source FROM meal_entries WHERE id=? AND user_id=?", id, userId);
  return e ? { id: e.id, name: e.food_name, amount: e.amount, unit: e.unit, nutrition_source: e.nutrition_source } : null;
}
async function estimateNutrition(env: Env, target: Estimable) {
  const prompt = `次の食品1回分の栄養を日本食品標準成分表の知識で推定し、JSONのみで返してください。キーは ${NUTRIENT_KEYS.join(", ")}。不明なキーは省略。値は数値のみ。\n食品: ${target.name}${target.amount != null ? ` ${target.amount}${target.unit ?? ""}` : ""}`;
  const r = await chatJson<Record<string, unknown>>(env, [{ role: "system", content: "あなたは管理栄養士です。JSONオブジェクトのみを出力します。" }, { role: "user", content: prompt }], {});
  return { estimate: parseNutrition(JSON.stringify(r.data)), provider: r.provider };
}
routes.post("/meals/:kind/:id/estimate", async (c) => {
  const user = c.get("user");
  const kind = z.enum(["entry", "food"]).parse(c.req.param("kind"));
  const id = c.req.param("id");
  const b = z.object({ confirm: z.boolean().optional(), apply: z.boolean().optional(), nutrition: nutritionSchema }).parse(await c.req.json().catch(() => ({})));
  const cur = await loadEstimable(c.env, user.id, kind, id);
  if (!cur) return c.json({ error: "not found" }, 404);
  let est: Nutrition | null = null, provider = "given";
  if (b.nutrition && Object.keys(b.nutrition).length) est = b.nutrition as Nutrition;
  else { const r = await estimateNutrition(c.env, cur); est = r.estimate; provider = r.provider; }
  if (!est) return c.json({ applied: false, reason: "ai_unavailable", estimate: null, provider });
  if (cur.nutrition_source === "recorded" && !b.confirm) return c.json({ applied: false, reason: "recorded", estimate: est, provider });
  if (b.apply === false) return c.json({ applied: false, reason: "preview", estimate: est, provider });
  const table = kind === "food" ? "meal_foods" : "meal_entries";
  await run(c.env.DB, `UPDATE ${table} SET nutrition_json=?, nutrition_source='estimated', updated_at=datetime('now') WHERE id=? AND user_id=?`, JSON.stringify(est), id, user.id);
  return c.json({ applied: true, estimate: est, provider });
});

/* ---------- Nutrition targets ---------- */
routes.get("/targets", async (c) => c.json({ targets: await getSetting(c.env, c.get("user").id, "nutrition_targets", {}) }));
routes.put("/targets", async (c) => {
  const user = c.get("user");
  const t = nutritionSchema.parse(await c.req.json());
  await setSetting(c.env, user.id, "nutrition_targets", t);
  return c.json({ targets: t });
});

/* ---------- Apply a meal chat proposal (today's log + targets) ---------- */
const nutritionLoose = z.record(z.string(), z.number()).nullable().optional();
const logOpZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), food_name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(), cost: z.number().min(0).nullable().optional(), nutrition: nutritionLoose, save_as_food: z.boolean().optional() }),
  z.object({ op: z.literal("update"), id: z.string().min(1), food_name: z.string().optional(), changes: z.object({ food_name: z.string().min(1).max(120).optional(), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(), cost: z.number().min(0).nullable().optional(), nutrition: nutritionLoose }) }),
  z.object({ op: z.literal("remove"), id: z.string().min(1), food_name: z.string().optional() }),
]);
routes.post("/meals/apply-proposal", async (c) => {
  const user = c.get("user");
  const b = z.object({ message_id: z.string().optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), entries: z.array(logOpZ).max(12).default([]), targets: nutritionLoose }).parse(await c.req.json());
  const day = b.day ?? jstDate();
  // Re-validate against the log as it is now (the proposal may be old).
  const existing = (await all<{ id: string; food_name: string; amount: number | null; nutrition_json: string | null; nutrition_source: string | null; cost: number | null }>(
    c.env.DB, "SELECT id,food_name,amount,nutrition_json,nutrition_source,cost FROM meal_entries WHERE user_id=? AND day=?", user.id, day));
  const norm = normalizeMealProposal({ entries: b.entries, targets: b.targets ?? null }, existing.map((m) => ({ id: m.id, food_name: m.food_name, amount: m.amount, nutrition: parseNutrition(m.nutrition_json) })));
  const stmts: D1PreparedStatement[] = [];
  const done = { added: 0, updated: 0, removed: 0, targets: false, skipped: b.entries.length - norm.entries.length };
  let order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_entries WHERE user_id=? AND day=?", user.id, day))?.n ?? 0;
  for (const op of norm.entries) {
    if (op.op === "add") {
      // Prefer 成分表 values over the AI's guess; fall back to the guess (marked estimated).
      const t = await lookupFood(c.env, { name: op.food_name, amount: op.amount, unit: op.unit }).catch(() => null);
      const nutrition = t?.match?.nutrition ?? (op.nutrition && Object.keys(op.nutrition).length ? op.nutrition : null);
      const source = t?.match ? "table" : nutrition ? "estimated" : null;
      const ref = t?.match ? JSON.stringify({ number: t.match.number, name: t.match.name, grams: t.match.grams, grams_estimated: t.match.grams_estimated }) : null;
      const hasN = Boolean(nutrition);
      stmts.push(c.env.DB.prepare("INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)")
        .bind(newId(), user.id, day, op.food_name, op.amount, op.unit, hasN ? JSON.stringify(nutrition) : null, source, ref, op.cost, order++));
      if (op.save_as_food) {
        const dup = await one<{ id: string }>(c.env.DB, "SELECT id FROM meal_foods WHERE user_id=? AND name=? AND archived_at IS NULL", user.id, op.food_name);
        stmts.push(dup
          ? c.env.DB.prepare("UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=?").bind(dup.id)
          : c.env.DB.prepare("INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,use_count,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now'))")
              .bind(newId(), user.id, op.food_name, op.amount, op.unit, hasN ? JSON.stringify(nutrition) : null, source, ref, op.cost));
      }
      done.added++;
    } else if (op.op === "update") {
      const cur = existing.find((m) => m.id === op.id)!; const ch = op.changes;
      let nJson = cur.nutrition_json, src = cur.nutrition_source;
      if (ch.nutrition) { nJson = JSON.stringify(ch.nutrition); src = "estimated"; }
      else if (ch.amount != null && cur.amount && parseNutrition(cur.nutrition_json)) {
        const scaled = scaleNutrition(parseNutrition(cur.nutrition_json), cur.amount, ch.amount);
        if (scaled) { nJson = JSON.stringify(scaled); src = "estimated"; }
      }
      stmts.push(c.env.DB.prepare("UPDATE meal_entries SET food_name=?,amount=?,unit=COALESCE(?,unit),nutrition_json=?,nutrition_source=?,cost=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
        .bind(ch.food_name ?? cur.food_name, ch.amount === undefined ? cur.amount : ch.amount, ch.unit ?? null, nJson, src, ch.cost === undefined ? cur.cost : ch.cost, op.id, user.id));
      done.updated++;
    } else {
      stmts.push(c.env.DB.prepare("DELETE FROM meal_entries WHERE id=? AND user_id=?").bind(op.id, user.id));
      done.removed++;
    }
  }
  if (norm.targets) {
    const cur = await getSetting<Nutrition>(c.env, user.id, "nutrition_targets", {});
    stmts.push(c.env.DB.prepare("INSERT INTO settings (user_id,key,value_json,updated_at) VALUES (?,'nutrition_targets',?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now')")
      .bind(user.id, JSON.stringify({ ...cur, ...norm.targets })));
    done.targets = true;
  }
  if (b.message_id) {
    const msg = await one<{ meta_json: string | null }>(c.env.DB, "SELECT meta_json FROM chat_messages WHERE id=? AND user_id=? AND channel='meal'", b.message_id, user.id);
    if (msg) {
      const meta = (() => { try { return JSON.parse(msg.meta_json ?? "{}"); } catch { return {}; } })();
      meta.applied = { at: new Date().toISOString(), ...done };
      stmts.push(c.env.DB.prepare("UPDATE chat_messages SET meta_json=? WHERE id=?").bind(JSON.stringify(meta), b.message_id));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, ...done, ...(await dayLog(c.env, user.id, day)) });
});

/* ---------- Beauty ---------- */
const beautyBody = z.object({ name: z.string().min(1).max(120), product: z.string().max(200).nullable().optional(), timing: z.string().max(60).nullable().optional(), purpose: z.string().max(200).nullable().optional() });
routes.get("/beauty", async (c) => {
  const user = c.get("user");
  return c.json({ items: await all(c.env.DB, "SELECT * FROM beauty_routines WHERE user_id=? ORDER BY created_at", user.id), policy: await getSetting(c.env, user.id, "beauty_policy", null) });
});
const policySchema = z.object({ keep: z.array(z.string()).default([]), add: z.array(z.string()).default([]), review: z.array(z.string()).default([]), note: z.string().optional() });
routes.get("/beauty/policy", async (c) => c.json({ policy: await getSetting(c.env, c.get("user").id, "beauty_policy", null) }));
routes.put("/beauty/policy", async (c) => {
  const user = c.get("user");
  const p = policySchema.parse(await c.req.json());
  const policy = { ...p, updated_at: new Date().toISOString() };
  await setSetting(c.env, user.id, "beauty_policy", policy);
  return c.json({ policy });
});

routes.post("/beauty", async (c) => {
  const user = c.get("user"); const b = beautyBody.parse(await c.req.json()); const id = newId();
  await run(c.env.DB, "INSERT INTO beauty_routines (id,user_id,name,product,timing,purpose) VALUES (?,?,?,?,?,?)", id, user.id, b.name, b.product ?? null, b.timing ?? null, b.purpose ?? null);
  return c.json({ item: await one(c.env.DB, "SELECT * FROM beauty_routines WHERE id=?", id) });
});
routes.put("/beauty/:id", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  const cur = await one<{ name: string; product: string | null; timing: string | null; purpose: string | null }>(c.env.DB, "SELECT * FROM beauty_routines WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = beautyBody.partial().parse(await c.req.json());
  await run(c.env.DB, "UPDATE beauty_routines SET name=?,product=?,timing=?,purpose=?,updated_at=datetime('now') WHERE id=?",
    b.name ?? cur.name, b.product === undefined ? cur.product : b.product, b.timing === undefined ? cur.timing : b.timing, b.purpose === undefined ? cur.purpose : b.purpose, id);
  return c.json({ item: await one(c.env.DB, "SELECT * FROM beauty_routines WHERE id=?", id) });
});
routes.delete("/beauty/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM beauty_routines WHERE id=? AND user_id=?", c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});
/* ---------- Checkups ---------- */
const CHECKUP_FIELDS = ["ldl", "hdl", "tg", "total_chol", "hba1c", "fasting_glucose", "bp_sys", "bp_dia", "ggtp", "ast", "alt", "uric_acid", "creatinine"] as const;
const checkupBody = z.object({
  checkup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), notes: z.string().max(2000).nullable().optional(),
  ...Object.fromEntries(CHECKUP_FIELDS.map((f) => [f, z.number().nullable().optional()])),
}) as z.ZodType<{ checkup_date: string; notes?: string | null } & Partial<Record<(typeof CHECKUP_FIELDS)[number], number | null>>>;
routes.get("/checkups", async (c) => c.json({ items: await all(c.env.DB, "SELECT * FROM checkups WHERE user_id=? ORDER BY checkup_date DESC", c.get("user").id) }));
routes.post("/checkups", async (c) => {
  const user = c.get("user"); const b = checkupBody.parse(await c.req.json()); const id = newId();
  await run(c.env.DB, `INSERT INTO checkups (id,user_id,checkup_date,${CHECKUP_FIELDS.join(",")},notes) VALUES (?,?,?,${CHECKUP_FIELDS.map(() => "?").join(",")},?)`,
    id, user.id, b.checkup_date, ...CHECKUP_FIELDS.map((f) => b[f] ?? null), b.notes ?? null);
  return c.json({ item: await one(c.env.DB, "SELECT * FROM checkups WHERE id=?", id) });
});
routes.put("/checkups/:id", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  if (!(await one(c.env.DB, "SELECT 1 FROM checkups WHERE id=? AND user_id=?", id, user.id))) return c.json({ error: "not found" }, 404);
  const b = checkupBody.parse(await c.req.json());
  await run(c.env.DB, `UPDATE checkups SET checkup_date=?,${CHECKUP_FIELDS.map((f) => `${f}=?`).join(",")},notes=? WHERE id=?`, b.checkup_date, ...CHECKUP_FIELDS.map((f) => b[f] ?? null), b.notes ?? null, id);
  return c.json({ item: await one(c.env.DB, "SELECT * FROM checkups WHERE id=?", id) });
});
routes.delete("/checkups/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM checkups WHERE id=? AND user_id=?", c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});

/* ---------- Pressure logs ---------- */
routes.get("/pressure/logs", async (c) => c.json({ items: await all(c.env.DB, "SELECT id,logged_at,symptom,severity,pressure_hpa,delta3h,delta6h FROM pressure_logs WHERE user_id=? AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 100", c.get("user").id) }));
routes.post("/pressure/logs", async (c) => {
  const user = c.get("user");
  const b = z.object({ symptom: z.string().max(200).nullable().optional(), severity: z.number().int().min(1).max(5).nullable().optional() }).parse(await c.req.json().catch(() => ({})));
  const w = await weatherCached(c.env, user.id);
  const id = newId();
  await run(c.env.DB, "INSERT INTO pressure_logs (id,user_id,logged_at,symptom,severity,pressure_hpa,delta3h,delta6h) VALUES (?,?,?,?,?,?,?,?)",
    id, user.id, new Date().toISOString(), b.symptom ?? null, b.severity ?? null, w?.pressure.current ?? null, w?.pressure.delta3h ?? null, w?.pressure.delta6h ?? null);
  return c.json({ item: await one(c.env.DB, "SELECT id,logged_at,symptom,severity,pressure_hpa,delta3h,delta6h FROM pressure_logs WHERE id=?", id), weather_available: Boolean(w) });
});
routes.patch("/pressure/logs/:id", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  const b = z.object({ symptom: z.string().max(200).nullable().optional(), severity: z.number().int().min(1).max(5).nullable().optional() }).parse(await c.req.json());
  const cur = await one<{ symptom: string | null; severity: number | null }>(c.env.DB, "SELECT symptom,severity FROM pressure_logs WHERE id=? AND user_id=? AND deleted_at IS NULL", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE pressure_logs SET symptom=?, severity=? WHERE id=?", b.symptom === undefined ? cur.symptom : b.symptom, b.severity === undefined ? cur.severity : b.severity, id);
  return c.json({ item: await one(c.env.DB, "SELECT id,logged_at,symptom,severity,pressure_hpa,delta3h,delta6h FROM pressure_logs WHERE id=?", id) });
});
routes.delete("/pressure/logs/:id", async (c) => {
  await run(c.env.DB, "UPDATE pressure_logs SET deleted_at=datetime('now') WHERE id=? AND user_id=?", c.req.param("id"), c.get("user").id);
  return c.json({ ok: true });
});
routes.get("/pressure/personal", async (c) => {
  const user = c.get("user");
  const logs = await all<{ delta3h: number | null }>(c.env.DB, "SELECT delta3h FROM pressure_logs WHERE user_id=? AND deleted_at IS NULL", user.id);
  const w = await weatherCached(c.env, user.id);
  return c.json(computePersonalThreshold(logs, w ? baselineAbsDeltas(w.pressure_series) : []));
});

/* ---------- Chats ---------- */
const CHANNELS = ["health", "meal", "beauty"] as const;
const ROLE_TEXT: Record<(typeof CHANNELS)[number], string> = {
  health: "健康コーチ。睡眠・回復・歩数・筋トレ・気圧・検診値を踏まえて今日の過ごし方を提案する。検査値から診断や治療方針は決めない。",
  meal: "管理栄養士。その日に食べた記録と目標を比較し、栄養の目標案や不足分を提案する。合計が途中の値のときは不足・過剰を断定しない。あなた自身は記録や目標を変更できない。変更の依頼には、完了した言い方（「追加しました」）も指示の言い方（「追加してください」）も使わず、「下のボタンで反映できます」と案内したうえで、変更後の栄養や費用への影響を短く添える。",
  beauty: "美容アドバイザー。睡眠・食事・活動・検診も参照し、「続けること」「追加候補」「見直すこと」を提案する。商品は根拠がないものを断定しない。",
};
type ChatRow = { id: string; role: "user" | "assistant"; content: string; meta_json: string | null; created_at: string };
const chatOut = (m: ChatRow) => { let meta: any = null; try { meta = m.meta_json ? JSON.parse(m.meta_json) : null; } catch { /* ignore */ } return { id: m.id, role: m.role, content: m.content, created_at: m.created_at, provider: meta?.provider, proposal: meta?.proposal ?? null, applied: meta?.applied ?? null }; };

routes.get("/chat/:channel", async (c) => {
  const ch = z.enum(CHANNELS).parse(c.req.param("channel"));
  const rows = await all<ChatRow>(c.env.DB, "SELECT id,role,content,meta_json,created_at FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT 60", c.get("user").id, ch);
  return c.json({ items: rows.reverse().map(chatOut) });
});
routes.delete("/chat/:channel", async (c) => {
  const ch = z.enum(CHANNELS).parse(c.req.param("channel"));
  await run(c.env.DB, "DELETE FROM chat_messages WHERE user_id=? AND channel=?", c.get("user").id, ch);
  return c.json({ ok: true });
});
routes.post("/chat/:channel", async (c) => {
  const user = c.get("user");
  const ch = z.enum(CHANNELS).parse(c.req.param("channel"));
  const { message } = z.object({ message: z.string().min(1).max(2000) }).parse(await c.req.json());
  const prior = (await all<ChatRow>(c.env.DB, "SELECT id,role,content,meta_json,created_at FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT 20", user.id, ch)).reverse();
  await run(c.env.DB, "INSERT INTO chat_messages (id,user_id,channel,role,content) VALUES (?,?,?,?,?)", newId(), user.id, ch, "user", message);
  const history = [...prior.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: message }];

  let roleText = ROLE_TEXT[ch];
  if (ch === "meal") {
    const log = await dayLog(c.env, user.id, jstDate());
    const foods = await all<{ name: string; amount: number | null; unit: string | null }>(c.env.DB, "SELECT name,amount,unit FROM meal_foods WHERE user_id=? AND archived_at IS NULL ORDER BY use_count DESC LIMIT 30", user.id);
    roleText += "\n記録の追加・変更・削除や目標の変更を頼まれたときは、提案内容が返信の下にカードで表示され、利用者がボタンを押すと反映されます。例:「ゆで卵2個（約140kcal・たんぱく質12g）を今日の記録に追加する提案です。下のボタンで反映できます。」";
    roleText += `\n今日の記録: ${JSON.stringify(log.entries.map((e) => ({ food_name: e.food_name, amount: e.amount, unit: e.unit, nutrition: e.nutrition })))}\n集計: ${JSON.stringify(log.summary.nutrition.totals)} partial=${log.summary.nutrition.partial}\n目標: ${JSON.stringify(log.summary.targets)}\nよく食べるもの: ${JSON.stringify(foods)}`;
  } else if (ch === "beauty") {
    const items = await all(c.env.DB, "SELECT name,product,timing,purpose FROM beauty_routines WHERE user_id=?", user.id);
    const policy = await getSetting(c.env, user.id, "beauty_policy", null);
    roleText += `\n美容ルーティン: ${JSON.stringify(items)}\n現在の方針: ${JSON.stringify(policy)}`;
  }
  const reply = await adviseWithContext(c.env, user.id, roleText, history);

  // Structured proposals (second call) for meal / beauty; only when the AI is actually reachable.
  let proposal: unknown = null;
  if (reply.provider !== "fallback") {
    if (ch === "meal") {
      const day = jstDate();
      const existing = await all<{ id: string; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null }>(
        c.env.DB, "SELECT id,food_name,amount,unit,nutrition_json FROM meal_entries WHERE user_id=? AND day=?", user.id, day);
      const r = await chatJson<Record<string, unknown>>(c.env, [
        { role: "system", content: [
          "あなたは管理栄養士です。直前の会話で利用者が求めた、または合意した変更だけを JSON のみで返します。推測で変更を足さないでください。",
          '形式: {"targets": {栄養キー: 1日の目標値} | null, "entries": [操作]}',
          '操作: {"op":"add","food_name":名前,"amount":数値|null,"unit":"g|個|杯など"|null,"cost":円|null,"nutrition":{栄養キー:その量の値}|null,"save_as_food":true}',
          '      {"op":"update","id":既存ID,"changes":{"food_name"?,"amount"?,"unit"?,"cost"?,"nutrition"?}}',
          '      {"op":"remove","id":既存ID}',
          'entries は「今日食べた記録」への操作です。save_as_food は「よく食べるもの」にも登録する場合 true。',
          `栄養キーは ${NUTRIENT_KEYS.join(", ")}。今日の記録(ID付き): ${JSON.stringify(existing.map((m) => ({ id: m.id, food_name: m.food_name, amount: m.amount, unit: m.unit })))}`,
          '変更がなければ {"targets": null, "entries": []}。',
        ].join("\n") },
        // Only the latest exchange: older turns slow the call down and bring back changes already applied.
        { role: "user", content: `依頼: ${message}` },
        { role: "assistant", content: reply.text.slice(0, 1500) },
        { role: "user", content: "この依頼と返答に含まれる変更だけをJSONで。" },
      ], { targets: null, entries: [] });
      const norm = normalizeMealProposal(r.data, existing.map((m) => ({ id: m.id, food_name: m.food_name, amount: m.amount, nutrition: parseNutrition(m.nutrition_json) })));
      if (norm.targets || norm.entries.length) proposal = { targets: norm.targets, entries: norm.entries, day };
      else if (!r.parsed) proposal = { error: "変更内容を読み取れませんでした。もう一度、短く具体的に指示してください（例: ゆで卵2個を食べた）。", targets: null, entries: [] };
    } else if (ch === "beauty") {
      const r = await chatJson<{ keep?: string[]; add?: string[]; review?: string[] }>(c.env, [
        { role: "system", content: "あなたは美容アドバイザーです。直前の会話の提案を JSON のみで返します。形式: {\"keep\": [続けること], \"add\": [追加候補], \"review\": [見直すこと]}。各要素は短い日本語。提案がなければ空配列。" },
        ...history.slice(-6), { role: "assistant", content: reply.text }, { role: "user", content: "上の提案をJSONで。" },
      ], { keep: [], add: [], review: [] });
      const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 10) : []);
      const p = { keep: arr(r.data?.keep), add: arr(r.data?.add), review: arr(r.data?.review) };
      if (p.keep.length || p.add.length || p.review.length) proposal = p;
    }
  }
  const id = newId();
  await run(c.env.DB, "INSERT INTO chat_messages (id,user_id,channel,role,content,meta_json) VALUES (?,?,?,?,?,?)", id, user.id, ch, "assistant", reply.text, JSON.stringify({ provider: reply.provider, proposal }));
  return c.json({ reply: reply.text, provider: reply.provider, proposal, id });
});
