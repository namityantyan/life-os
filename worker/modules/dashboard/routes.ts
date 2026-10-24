import { Hono } from "hono";
import type { AppEnv } from "../../env";
import type { WeatherLocation } from "../../../shared/types";
import { all, getSetting } from "../../core/db";
import { backgroundOf } from "../../core/background";
import { buildLifeContext, dailyHint } from "../../core/context";
import { fxQuotes } from "../fx/hub";
import { weatherFor, WEATHER_CODE_LABEL, type WeatherSnapshot } from "../../core/weather";

export const routes = new Hono<AppEnv>();

/** One call that feeds every dashboard card. Weather is stale-while-revalidate (core/weather); the AI hint never blocks. */
routes.get("/", async (c) => {
  const user = c.get("user");
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 9 * 3600e3 + 7 * 86400e3).toISOString().slice(0, 10);
  const loc = await getSetting<WeatherLocation | null>(c.env, user.id, "weather_location", null);
  let weather: (WeatherSnapshot & { weather_label: string | null }) | null = null;
  let weatherError: string | null = null;
  const bg = backgroundOf(c);
  if (loc) {
    try { const w = await weatherFor(c.env, loc, bg); weather = { ...w, weather_label: w.weather_code != null ? (WEATHER_CODE_LABEL[w.weather_code] ?? "—") : null }; }
    catch (e) { weatherError = String(e); }
  }
  const ctx = await buildLifeContext(c.env, user.id);
  if (weather) ctx.health.pressure = weather.pressure;
  const [tasks, events, pairs] = await Promise.all([
    all(c.env.DB, "SELECT id,title,date FROM planner_items WHERE user_id=? AND type='task' AND done_at IS NULL AND archived_at IS NULL ORDER BY (date IS NULL), date, created_at DESC LIMIT 30", user.id),
    all(c.env.DB, "SELECT id,title,start_at,end_at,type FROM planner_items WHERE user_id=? AND type='event' AND archived_at IS NULL AND substr(start_at,1,10)>=? AND substr(start_at,1,10)<=? ORDER BY start_at LIMIT 30", user.id, today, weekEnd),
    fxQuotes(c.env, user.id),
  ]);
  const [hint, layout] = await Promise.all([dailyHint(c.env, user.id, ctx, { background: bg }), getSetting<unknown>(c.env, user.id, "dashboard_layout", null)]);
  return c.json({ context: ctx, suggestion: hint.text, suggestionSource: hint.source, weather, weatherError, weatherConfigured: Boolean(loc), tasks, events, fxPairs: pairs, today, layout });
});
