import type { Env } from "./env";
import { all, one, run, getSetting, jstDate, jstHour } from "./core/db";
import { notify, processQueue } from "./core/notify";
import { buildLifeContext, suggestAction, dailyHint } from "./core/context";

/** Cron entry. Schedules in wrangler.jsonc: every 10 min, hourly, daily 22:00 UTC (07:00 JST). */
export async function runScheduled(env: Env, cron: string) {
  const users = await all<{ id: string }>(env.DB, "SELECT id FROM users");
  await processQueue(env);
  for (const u of users) {
    try { await fireDueReminders(env, u.id); } catch (e) { console.error("reminders", e); }
    if (cron === "*/10 * * * *" || cron === "0 * * * *") {
      try { const m = await import("./modules/health/oura"); await m.syncOura(env, u.id); } catch (e) { console.error("oura", e); }
    }
    if (cron === "0 * * * *") {
      try { const m = await import("./modules/assets/freee"); await m.syncFreeeBalances(env, u.id); } catch (e) { console.error("freee", e); }
      try { await maybeMorning(env, u.id); } catch (e) { console.error("morning", e); }
      try { await maybeBedtime(env, u.id); } catch (e) { console.error("bedtime", e); }
      try { const m = await import("./modules/backups/routes"); await m.checkBackupStaleness(env, u.id); } catch (e) { console.error("backup", e); }
    }
    if (cron === "0 22 * * *") {
      try { await maybeMorning(env, u.id); } catch (e) { console.error("morning", e); }
      try { const m = await import("./modules/finance/routes"); await m.monthlyWithholdingReminder(env, u.id); } catch (e) { console.error("withholding", e); }
      try { await maybeWeekly(env, u.id); } catch (e) { console.error("weekly", e); }
    }
  }
  await processQueue(env);
}

async function fireDueReminders(env: Env, userId: string) {
  const due = await all<{ id: string; title: string; notes: string | null; remind_at: string }>(env.DB, "SELECT id,title,notes,remind_at FROM planner_items WHERE user_id=? AND type='reminder' AND reminded_at IS NULL AND archived_at IS NULL AND remind_at IS NOT NULL AND remind_at<=?", userId, new Date().toISOString());
  for (const r of due) {
    await notify(env, userId, { kind: "reminder", title: r.title, body: r.notes ?? undefined, url: "/planner", dedupeKey: `reminder:${r.id}:${r.remind_at}` });
    await run(env.DB, "UPDATE planner_items SET reminded_at=datetime('now') WHERE id=?", r.id);
  }
}

async function maybeMorning(env: Env, userId: string) {
  const hour = jstHour();
  if (hour < 7 || hour > 9) return;
  const key = `morning:${userId}:${jstDate()}`;
  if (await one(env.DB, "SELECT 1 FROM job_runs WHERE job='daily' AND key=?", key)) return;
  await run(env.DB, "INSERT INTO job_runs (job,key) VALUES ('daily',?)", key);
  const include = await getSetting<{ oura: boolean; events: boolean; tasks: boolean; meals: boolean }>(env, userId, "morning_contents", { oura: true, events: true, tasks: true, meals: false });
  const ctx = await buildLifeContext(env, userId, { weather: true });
  const lines: string[] = [(await dailyHint(env, userId, ctx)).text];
  if (include.oura && ctx.health.oura_is_today && ctx.health.oura) lines.push(`睡眠 ${ctx.health.oura.sleep_score ?? "—"} / 回復 ${ctx.health.oura.readiness_score ?? "—"}`);
  if (include.events && ctx.planner.events_today.length) lines.push(`予定 ${ctx.planner.events_today.map((e) => e.title).join("、")}`);
  if (include.tasks) lines.push(`未完了タスク ${ctx.planner.tasks_open}件`);
  if (include.meals && ctx.health.meal_summary?.energy_kcal) lines.push(`食事ルーティン ${Math.round(ctx.health.meal_summary.energy_kcal)} kcal`);
  await notify(env, userId, { kind: "morning", title: "おはようございます", body: lines.join("\n"), url: "/" });
}

async function maybeBedtime(env: Env, userId: string) {
  if (jstHour() !== 23) return;
  const key = `bedtime:${userId}:${jstDate()}`;
  if (await one(env.DB, "SELECT 1 FROM job_runs WHERE job='daily' AND key=?", key)) return;
  await run(env.DB, "INSERT INTO job_runs (job,key) VALUES ('daily',?)", key);
  await notify(env, userId, { kind: "bedtime", title: "そろそろ就寝の時間です", body: "明日の予定を確認して、画面を閉じましょう。", url: "/planner" });
}

async function maybeWeekly(env: Env, userId: string) {
  const d = new Date(Date.now() + 9 * 3600e3);
  if (d.getUTCDay() !== 1) return; // Monday JST
  const key = `weekly:${userId}:${jstDate()}`;
  if (await one(env.DB, "SELECT 1 FROM job_runs WHERE job='daily' AND key=?", key)) return;
  await run(env.DB, "INSERT INTO job_runs (job,key) VALUES ('daily',?)", key);
  const ctx = await buildLifeContext(env, userId);
  await notify(env, userId, { kind: "weekly", title: "週次まとめ", body: `先週のトレーニング ${ctx.training.sessions_7d}回、未完了タスク ${ctx.planner.tasks_open}件、今月のカード利用 ${ctx.money.card_month_total != null ? Math.round(ctx.money.card_month_total).toLocaleString() + "円" : "未取得"}`, url: "/" });
}
