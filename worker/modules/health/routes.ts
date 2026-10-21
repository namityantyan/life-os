import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import type { WeatherLocation } from "../../../shared/types";
import { all, one, run, newId, getSetting, setSetting, jstDate, kvPutSafe } from "../../core/db";
import { chatJson } from "../../core/ai";
import { adviseWithContext, buildLifeContext, suggestAction } from "../../core/context";
import { fetchWeather, type WeatherSnapshot } from "../../core/weather";
import { syncOura } from "./oura";
import { NUTRIENT_KEYS, summarizeNutrition, estimateCost, computePersonalThreshold, parseNutrition, type Nutrition, type NutrientKey } from "./logic";

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
    pressure_logs: logs,
    personal,
  });
});

routes.post("/oura/sync", async (c) => {
  const user = c.get("user");
  try { return c.json({ ok: true, ...(await syncOura(c.env, user.id)) }); }
  catch (e) { return c.json({ ok: false, error: String((e as Error)?.message ?? e) }, 502); }
});

/* ---------- Meals ---------- */
const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
const mealBody = z.object({
  slot: z.enum(SLOTS), food_name: z.string().min(1).max(120), amount: z.number().nullable().optional(), unit: z.string().max(20).nullable().optional(),
  nutrition: nutritionSchema.nullable().optional(), cost_per_serving: z.number().min(0).nullable().optional(), sort_order: z.number().int().optional(),
});
type MealRow = { id: string; slot: string; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null; sort_order: number; updated_at: string };
const mealOut = (m: MealRow) => ({ ...m, nutrition: parseNutrition(m.nutrition_json) });

async function mealSummary(env: Env, userId: string) {
  const items = await all<MealRow>(env.DB, "SELECT * FROM meal_routines WHERE user_id=?", userId);
  const targets = await getSetting<Partial<Record<NutrientKey, number>>>(env, userId, "nutrition_targets", {});
  return { nutrition: summarizeNutrition(items), cost: estimateCost(items), targets };
}
routes.get("/meals", async (c) => {
  const user = c.get("user");
  const items = await all<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE user_id=? ORDER BY CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, sort_order, created_at", user.id);
  return c.json({ items: items.map(mealOut), summary: await mealSummary(c.env, user.id) });
});
routes.get("/meals/summary", async (c) => c.json(await mealSummary(c.env, c.get("user").id)));
routes.post("/meals", async (c) => {
  const user = c.get("user");
  const b = mealBody.parse(await c.req.json());
  const id = newId();
  const hasN = b.nutrition && Object.keys(b.nutrition).length > 0;
  await run(c.env.DB, "INSERT INTO meal_routines (id,user_id,slot,food_name,amount,unit,nutrition_json,nutrition_source,cost_per_serving,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, user.id, b.slot, b.food_name, b.amount ?? null, b.unit ?? null, hasN ? JSON.stringify(b.nutrition) : null, hasN ? "recorded" : null, b.cost_per_serving ?? null, b.sort_order ?? 0);
  return c.json({ item: mealOut((await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", id))!) });
});
routes.put("/meals/:id", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  const cur = await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = mealBody.partial().parse(await c.req.json());
  let nutritionJson = cur.nutrition_json, source = cur.nutrition_source;
  if (b.nutrition !== undefined) {
    if (b.nutrition && Object.keys(b.nutrition).length) { nutritionJson = JSON.stringify(b.nutrition); source = "recorded"; }
    else { nutritionJson = null; source = null; }
  }
  await run(c.env.DB, "UPDATE meal_routines SET slot=?,food_name=?,amount=?,unit=?,nutrition_json=?,nutrition_source=?,cost_per_serving=?,sort_order=?,updated_at=datetime('now') WHERE id=?",
    b.slot ?? cur.slot, b.food_name ?? cur.food_name, b.amount === undefined ? cur.amount : b.amount, b.unit === undefined ? cur.unit : b.unit,
    nutritionJson, source, b.cost_per_serving === undefined ? cur.cost_per_serving : b.cost_per_serving, b.sort_order ?? cur.sort_order, id);
  return c.json({ item: mealOut((await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", id))!) });
});
routes.delete("/meals/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM meal_routines WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});
/** AI nutrition estimate. Recorded values are never overwritten unless `confirm:true`. Fallback (AI offline) stores nothing. */
routes.post("/meals/:id/estimate", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  const b = z.object({ confirm: z.boolean().optional(), apply: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  const cur = await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const prompt = `次の食品1回分の栄養を日本食品標準成分表の知識で推定し、JSONのみで返してください。キーは ${NUTRIENT_KEYS.join(", ")}。不明なキーは省略。値は数値のみ。\n食品: ${cur.food_name}${cur.amount != null ? ` ${cur.amount}${cur.unit ?? ""}` : ""}`;
  const r = await chatJson<Record<string, unknown>>(c.env, [{ role: "system", content: "あなたは管理栄養士です。JSONオブジェクトのみを出力します。" }, { role: "user", content: prompt }], {});
  const est = parseNutrition(JSON.stringify(r.data));
  if (r.provider === "fallback" || !est) return c.json({ applied: false, reason: "ai_unavailable", estimate: null, provider: r.provider });
  if (cur.nutrition_source === "recorded" && !b.confirm) return c.json({ applied: false, reason: "recorded", estimate: est, provider: r.provider });
  if (b.apply === false) return c.json({ applied: false, reason: "preview", estimate: est, provider: r.provider });
  await run(c.env.DB, "UPDATE meal_routines SET nutrition_json=?, nutrition_source='estimated', updated_at=datetime('now') WHERE id=?", JSON.stringify(est), id);
  return c.json({ applied: true, estimate: est, provider: r.provider, item: mealOut((await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", id))!) });
});
/** Apply an estimate coming from the meal chat ("推定値を反映"). Same overwrite rule. */
routes.post("/meals/:id/apply-estimate", async (c) => {
  const user = c.get("user"); const id = c.req.param("id");
  const b = z.object({ nutrition: nutritionSchema, confirm: z.boolean().optional() }).parse(await c.req.json());
  const cur = await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  if (cur.nutrition_source === "recorded" && !b.confirm) return c.json({ applied: false, reason: "recorded" });
  await run(c.env.DB, "UPDATE meal_routines SET nutrition_json=?, nutrition_source='estimated', updated_at=datetime('now') WHERE id=?", JSON.stringify(b.nutrition), id);
  return c.json({ applied: true, item: mealOut((await one<MealRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", id))!) });
});

/* ---------- Nutrition targets ---------- */
routes.get("/targets", async (c) => c.json({ targets: await getSetting(c.env, c.get("user").id, "nutrition_targets", {}) }));
routes.put("/targets", async (c) => {
  const user = c.get("user");
  const t = nutritionSchema.parse(await c.req.json());
  await setSetting(c.env, user.id, "nutrition_targets", t);
  return c.json({ targets: t });
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
  meal: "管理栄養士。登録された食事ルーティン（食べる予定）と目標を比較し、栄養の目標案や不足分の推定を提案する。合計が途中の値のときは不足・過剰を断定しない。",
  beauty: "美容アドバイザー。睡眠・食事・活動・検診も参照し、「続けること」「追加候補」「見直すこと」を提案する。商品は根拠がないものを断定しない。",
};
type ChatRow = { id: string; role: "user" | "assistant"; content: string; meta_json: string | null; created_at: string };
const chatOut = (m: ChatRow) => { let meta: any = null; try { meta = m.meta_json ? JSON.parse(m.meta_json) : null; } catch { /* ignore */ } return { id: m.id, role: m.role, content: m.content, created_at: m.created_at, provider: meta?.provider, proposal: meta?.proposal ?? null }; };

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
    const s = await mealSummary(c.env, user.id);
    const items = await all<MealRow>(c.env.DB, "SELECT slot,food_name,amount,unit,nutrition_json,nutrition_source,cost_per_serving FROM meal_routines WHERE user_id=?", user.id);
    roleText += `\n食事ルーティン: ${JSON.stringify(items.map(mealOut).map(({ nutrition_json: _n, ...m }) => m))}\n集計: ${JSON.stringify(s.nutrition.totals)} partial=${s.nutrition.partial}\n目標: ${JSON.stringify(s.targets)}`;
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
      const r = await chatJson<{ targets?: Record<string, number> | null; estimates?: { food_name: string; nutrition: Record<string, number> }[] }>(c.env, [
        { role: "system", content: `あなたは管理栄養士です。直前の会話から、提案があれば JSON のみで返します。形式: {"targets": {栄養キー: 数値} | null, "estimates": [{"food_name": 登録名, "nutrition": {栄養キー: 数値}}]}。栄養キーは ${NUTRIENT_KEYS.join(", ")}。提案がなければ {"targets": null, "estimates": []}。` },
        ...history.slice(-6), { role: "assistant", content: reply.text }, { role: "user", content: "上の提案をJSONで。" },
      ], { targets: null, estimates: [] });
      const targets = r.data?.targets ? parseNutrition(JSON.stringify(r.data.targets)) : null;
      const estimates = Array.isArray(r.data?.estimates) ? r.data.estimates.map((e) => ({ food_name: String(e?.food_name ?? ""), nutrition: parseNutrition(JSON.stringify(e?.nutrition ?? {})) })).filter((e) => e.food_name && e.nutrition) : [];
      if (targets || estimates.length) proposal = { targets, estimates };
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
