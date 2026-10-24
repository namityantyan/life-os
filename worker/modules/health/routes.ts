import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import type { WeatherLocation } from "../../../shared/types";
import { all, one, run, newId, getSetting, setSetting, jstDate, kvPutSafe } from "../../core/db";
import { chatJson } from "../../core/ai";
import { adviseWithContext, buildLifeContext, suggestAction } from "../../core/context";
import { weatherCached } from "../../core/weather";
import { backgroundOf } from "../../core/background";
import { syncOura } from "./oura";
import { mealRoutes, mealChatContext, getTargets, putTargets } from "./meals";
import { NUTRIENT_KEYS, computePersonalThreshold, parseNutrition, normalizeMealProposal, type Nutrition } from "./logic";

export const routes = new Hono<AppEnv>();

/* ---------- helpers ---------- */
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
    weatherCached(c.env, user.id, backgroundOf(c)),
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

/* ---------- Meals: daily log, saved foods, sets, 成分表, chat proposals (meals.ts) ---------- */
routes.route("/meals", mealRoutes);

/* ---------- Nutrition targets ---------- */
routes.get("/targets", async (c) => c.json({ targets: await getTargets(c.env, c.get("user").id) }));
routes.put("/targets", async (c) => c.json({ targets: await putTargets(c.env, c.get("user").id, nutritionSchema.parse(await c.req.json())) }));

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
  const w = await weatherCached(c.env, user.id, backgroundOf(c));
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
  const w = await weatherCached(c.env, user.id, backgroundOf(c));
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
    const { log, foods } = await mealChatContext(c.env, user.id);
    roleText += "\n記録の追加・変更・削除や目標の変更を頼まれたときは、提案内容が返信の下にカードで表示され、利用者がボタンを押すと反映されます。例:「ゆで卵2個（約140kcal・たんぱく質12g）を今日の記録に追加する提案です。下のボタンで反映できます。」";
    roleText += "\nビタミンDは利用者には IU で伝える（データの値は µg、1µg = 40IU）。";
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
          "値の単位はキー末尾のとおり（_ug は µg）。ビタミンDを IU で言われたら 40 で割って µg にする（例: 1000IU → 25）。",
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
