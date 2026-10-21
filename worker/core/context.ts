import type { Env } from "../env";
import type { LifeContext, WeatherLocation } from "../../shared/types";
import { all, one, getSetting, jstDate, jstNow, kvPutSafe } from "./db";
import { fetchWeather } from "./weather";
import { fxSummary } from "../modules/fx/hub";
import { chat } from "./ai";

/**
 * Builds the cross-module "Life Context" snapshot. Every AI advice feature
 * (dashboard hint, health/meal/beauty/FP chats, Discord) is grounded in this object,
 * so advice reflects sleep, training, schedule, money and the user's own notes at once.
 * Values that are missing or stale are reported as null / flagged, never guessed.
 */
export async function buildLifeContext(env: Env, userId: string, opts: { weather?: boolean } = {}): Promise<LifeContext> {
  const today = jstDate();
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const [user, oura, lastSession, sessionsWeek, tasksOpen, eventsToday, remindersPending, cardMonth, notes, checkup, meals, beautyCount, fx, cashRow] = await Promise.all([
    one<{ name: string | null }>(env.DB, "SELECT name FROM users WHERE id=?", userId),
    one<LifeContext["health"]["oura"] & { day: string }>(env.DB, "SELECT day,sleep_duration_sec,sleep_score,readiness_score,steps,hrv,resting_hr,sleep_balance FROM oura_daily WHERE user_id=? ORDER BY day DESC LIMIT 1", userId),
    one<{ part: string; started_at: string }>(env.DB, "SELECT part,started_at FROM training_sessions WHERE user_id=? ORDER BY started_at DESC LIMIT 1", userId),
    one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM training_sessions WHERE user_id=? AND started_at>=?", userId, weekAgo),
    one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM planner_items WHERE user_id=? AND type='task' AND done_at IS NULL AND archived_at IS NULL", userId),
    all<{ title: string; start_at: string | null }>(env.DB, "SELECT title,start_at FROM planner_items WHERE user_id=? AND type='event' AND archived_at IS NULL AND substr(start_at,1,10)=? ORDER BY start_at", userId, today),
    one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM planner_items WHERE user_id=? AND type='reminder' AND reminded_at IS NULL AND remind_at IS NOT NULL AND archived_at IS NULL", userId),
    one<{ total: number | null }>(env.DB, "SELECT SUM(amount) total FROM card_transactions WHERE user_id=? AND status!='cancelled' AND source!='csv' AND substr(used_at,1,7)=?", userId, today.slice(0, 7)),
    all<{ category: string; content: string }>(env.DB, "SELECT category,content FROM notes WHERE user_id=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 30", userId),
    one<Record<string, unknown>>(env.DB, "SELECT checkup_date,ldl,hdl,tg,total_chol,hba1c,fasting_glucose,bp_sys,bp_dia,ggtp,ast,alt,uric_acid,creatinine FROM checkups WHERE user_id=? ORDER BY checkup_date DESC LIMIT 1", userId),
    all<{ nutrition_json: string | null }>(env.DB, "SELECT nutrition_json FROM meal_entries WHERE user_id=? AND day=?", userId, today),
    one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM beauty_routines WHERE user_id=?", userId),
    fxSummary(env, userId),
    one<{ total: number | null; latest: string | null }>(env.DB,
      `SELECT SUM(b.jpy_value) total, MAX(b.recorded_on) latest FROM asset_accounts a
       JOIN asset_balances b ON b.id = (SELECT id FROM asset_balances WHERE account_id=a.id ORDER BY recorded_on DESC, created_at DESC LIMIT 1)
       WHERE a.user_id=? AND a.owner_type='personal' AND a.category='bank' AND a.currency='JPY' AND a.archived_at IS NULL`, userId),
  ]);

  const budget = await getSetting<{ monthly_budget: number | null }>(env, userId, "card_settings", { monthly_budget: null });
  let mealSummary: LifeContext["health"]["meal_summary"] = null;
  if (meals.length) {
    const sum = { energy_kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 }; let partial = false;
    for (const m of meals) {
      if (!m.nutrition_json) { partial = true; continue; }
      const n = JSON.parse(m.nutrition_json) as Record<string, number>;
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) { if (typeof n[k] === "number") sum[k] += n[k]; else partial = true; }
    }
    mealSummary = { ...sum, partial };
  }

  let pressure: LifeContext["health"]["pressure"] = null;
  if (opts.weather) {
    const loc = await getSetting<WeatherLocation | null>(env, userId, "weather_location", null);
    if (loc) { try { pressure = (await fetchWeather(loc)).pressure; } catch { pressure = null; } }
  }
  const cashFresh = Boolean(cashRow?.latest && cashRow.latest >= new Date(Date.now() - 2 * 86400e3).toISOString().slice(0, 10));

  return {
    now: jstNow().toISOString().replace("Z", "+09:00"),
    user: { name: user?.name ?? null },
    health: {
      oura: oura ?? null,
      oura_is_today: oura?.day === today,
      pressure,
      checkup_latest: checkup ?? null,
      meal_summary: mealSummary,
      beauty_routine_count: beautyCount?.n ?? 0,
    },
    training: {
      trained_today: Boolean(lastSession && lastSession.started_at.slice(0, 10) === today),
      last_session: lastSession ?? null,
      sessions_7d: sessionsWeek?.n ?? 0,
    },
    planner: { tasks_open: tasksOpen?.n ?? 0, events_today: eventsToday, reminders_pending: remindersPending?.n ?? 0 },
    money: {
      card_month_total: cardMonth?.total ?? null,
      card_budget: budget.monthly_budget,
      card_budget_left: budget.monthly_budget != null ? budget.monthly_budget - (cardMonth?.total ?? 0) : null,
      personal_jpy_cash: cashRow?.total ?? null,
      cash_is_fresh: cashFresh,
    },
    fx,
    notes,
  };
}

/** Rule-based daily action suggestion (deterministic; AI is layered on top in chats). */
export function suggestAction(ctx: LifeContext): string {
  const hour = Number(ctx.now.slice(11, 13));
  const o = ctx.health.oura_is_today ? ctx.health.oura : null;
  const lowRecovery = o && ((o.readiness_score != null && o.readiness_score < 70) || (o.sleep_score != null && o.sleep_score < 70));
  if (lowRecovery) return hour < 12 ? "回復度が低めです。今日は負荷を抑えて、昼までに軽い散歩と水分補給を。" : "回復度が低めです。夜は追加の負荷をかけず、ほぐしと早めの就寝を。";
  if (ctx.training.trained_today) return "今日の筋トレは記録済み。追加の負荷は不要で、散歩やストレッチで整えましょう。";
  if (o && o.steps != null && o.steps < 4000 && hour >= 15) return "今日の歩数が少なめです。夕方に20〜30分の散歩を入れると整います。";
  if (!ctx.health.oura_is_today) return "今日のOuraデータが未同期です。リングを同期すると提案が更新されます。";
  if (ctx.planner.tasks_open > 5) return `未完了タスクが${ctx.planner.tasks_open}件。午前中に2つ片付けると軽くなります。`;
  return hour < 10 ? "コンディション良好。午前中に重めのタスクかトレーニングを。" : "コンディション良好。予定どおり動けます。";
}

export function contextSystemPrompt(ctx: LifeContext, role: string): string {
  return [
    `あなたはLife OSのアシスタントです。役割: ${role}。日本語で、簡潔に、断定しすぎずに答えます。`,
    "以下は利用者の生活データのスナップショットです。欠測やnullは「不明」として扱い、推測で埋めないでください。診断・投資・送金の実行はしません。",
    "有効なメモ（方針・決定・好み）を前提として尊重してください。",
    JSON.stringify(ctx),
  ].join("\n");
}

export async function adviseWithContext(env: Env, userId: string, role: string, history: { role: "user" | "assistant"; content: string }[]) {
  const ctx = await buildLifeContext(env, userId, { weather: true });
  return chat(env, [{ role: "system", content: contextSystemPrompt(ctx, role) }, ...history]);
}

/**
 * One-line daily hint. Rule-based `suggestAction` is always computed; when Workers AI is
 * available the hint is refined with the full Life Context (cached per user per hour in KV).
 */
export async function dailyHint(env: Env, userId: string, ctx: LifeContext): Promise<{ text: string; source: "ai" | "rules" }> {
  const base = suggestAction(ctx);
  if (!env.AI) return { text: base, source: "rules" };
  const key = `hint:${userId}:${ctx.now.slice(0, 13)}`;
  const cached = await env.KV.get(key);
  if (cached) return { text: cached, source: "ai" };
  const r = await chat(env, [
    { role: "system", content: contextSystemPrompt(ctx, "ダッシュボードの一言アドバイス。60文字以内の日本語1文。見出し・絵文字・前置きなし。欠測は推測しない。") },
    { role: "user", content: `ルールベースの案: 「${base}」。必要なら生活データ全体を踏まえて言い換え、そのまま1文だけ返してください。` },
  ], { maxTokens: 120 });
  if (r.provider !== "workers-ai") return { text: base, source: "rules" };
  const text = r.text.replace(/^["「]|["」]$/g, "").split("\n")[0].trim().slice(0, 90);
  if (!text) return { text: base, source: "rules" };
  await kvPutSafe(env, key, text, { expirationTtl: 3600 });
  return { text, source: "ai" };
}
