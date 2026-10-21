/**
 * Meals: a daily log of what was actually eaten, filled in with one tap from saved foods
 * ("よく食べるもの") or saved sets ("いつもの食事"). Nutrition and cost are copied into each entry,
 * so editing a saved food later never rewrites past days.
 *
 * Legacy: meal_routines rows are the members of a set (set_id). Rows from the previous
 * "routine = plan" model are migrated once, on first read, into a set plus saved foods.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, getSetting, jstDate } from "../../core/db";
import { summarizeNutrition, estimateCost, parseNutrition, scaleNutrition, type Nutrition, type NutrientKey } from "./logic";

export const mealRoutes = new Hono<AppEnv>();

const nutritionSchema = z.record(z.string(), z.number()).nullable().optional();
const dayZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type FoodRow = { id: string; name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null; use_count: number; last_used_at: string | null };
type EntryRow = { id: string; day: string; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost: number | null; servings: number; food_id: string | null; set_id: string | null; sort_order: number };
type SetRow = { id: string; name: string; sort_order: number };
type MemberRow = { id: string; set_id: string | null; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null; sort_order: number; slot: string };

const foodOut = (f: FoodRow) => ({ ...f, nutrition: parseNutrition(f.nutrition_json) });
const entryOut = (e: EntryRow) => ({ ...e, nutrition: parseNutrition(e.nutrition_json) });
const memberOut = (m: MemberRow) => ({ ...m, nutrition: parseNutrition(m.nutrition_json) });
/** Entries carry an absolute cost; summarizeNutrition/estimateCost expect `cost_per_serving`. */
const forSummary = (e: EntryRow) => ({ nutrition_json: e.nutrition_json, nutrition_source: e.nutrition_source, cost_per_serving: e.cost });

const SLOT_SET_NAME: Record<string, string> = { breakfast: "いつもの朝食", lunch: "いつもの昼食", dinner: "いつもの夕食", snack: "いつもの間食" };

/**
 * One-time migration from the old model: each slot that has rows becomes a set, and every row
 * also becomes a saved food. Runs inside a transaction; safe to call on every read.
 */
async function migrateLegacy(env: Env, userId: string): Promise<void> {
  const orphans = await all<MemberRow>(env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NULL ORDER BY CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, sort_order, created_at", userId);
  if (!orphans.length) return;
  const existingFoods = await all<{ name: string }>(env.DB, "SELECT name FROM meal_foods WHERE user_id=?", userId);
  const known = new Set(existingFoods.map((f) => f.name));
  const stmts: D1PreparedStatement[] = [];
  const setIds = new Map<string, string>();
  let order = (await one<{ n: number }>(env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_sets WHERE user_id=?", userId))?.n ?? 0;
  for (const m of orphans) {
    if (!setIds.has(m.slot)) {
      const sid = newId();
      setIds.set(m.slot, sid);
      stmts.push(env.DB.prepare("INSERT INTO meal_sets (id,user_id,name,sort_order) VALUES (?,?,?,?)").bind(sid, userId, SLOT_SET_NAME[m.slot] ?? "いつもの食事", order++));
    }
    stmts.push(env.DB.prepare("UPDATE meal_routines SET set_id=? WHERE id=?").bind(setIds.get(m.slot), m.id));
    if (!known.has(m.food_name)) {
      known.add(m.food_name);
      stmts.push(env.DB.prepare("INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,cost_per_serving) VALUES (?,?,?,?,?,?,?,?)")
        .bind(newId(), userId, m.food_name, m.amount, m.unit, m.nutrition_json, m.nutrition_source, m.cost_per_serving));
    }
  }
  await env.DB.batch(stmts);
}

export async function dayLog(env: Env, userId: string, day: string) {
  const entries = await all<EntryRow>(env.DB, "SELECT * FROM meal_entries WHERE user_id=? AND day=? ORDER BY sort_order, created_at", userId, day);
  const targets = await getSetting<Partial<Record<NutrientKey, number>>>(env, userId, "nutrition_targets", {});
  return { day, entries: entries.map(entryOut), summary: { nutrition: summarizeNutrition(entries.map(forSummary)), cost: estimateCost(entries.map(forSummary)), targets } };
}

/* ---------------------------------------------------------------- day log */
mealRoutes.get("/day", async (c) => {
  const user = c.get("user");
  const day = dayZ.parse(c.req.query("day") || jstDate());
  await migrateLegacy(c.env, user.id);
  const [log, foods, sets] = await Promise.all([
    dayLog(c.env, user.id, day),
    all<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE user_id=? AND archived_at IS NULL ORDER BY use_count DESC, last_used_at DESC, created_at", user.id),
    all<SetRow>(c.env.DB, "SELECT * FROM meal_sets WHERE user_id=? AND archived_at IS NULL ORDER BY sort_order, created_at", user.id),
  ]);
  const members = sets.length ? await all<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NOT NULL ORDER BY sort_order, created_at", user.id) : [];
  return c.json({
    ...log,
    foods: foods.map(foodOut),
    sets: sets.map((s) => { const ms = members.filter((m) => m.set_id === s.id).map(memberOut); return { ...s, items: ms, nutrition: summarizeNutrition(ms), cost: estimateCost(ms) }; }),
  });
});

/** Recent days with their totals, for the history strip. */
mealRoutes.get("/days", async (c) => {
  const user = c.get("user");
  const limit = Math.min(Number(c.req.query("limit") ?? 14), 90);
  const days = await all<{ day: string }>(c.env.DB, "SELECT DISTINCT day FROM meal_entries WHERE user_id=? ORDER BY day DESC LIMIT ?", user.id, limit);
  const rows = await all<EntryRow>(c.env.DB, `SELECT * FROM meal_entries WHERE user_id=? AND day IN (${days.map(() => "?").join(",") || "''"})`, user.id, ...days.map((d) => d.day));
  return c.json({ items: days.map((d) => { const e = rows.filter((r) => r.day === d.day); return { day: d.day, count: e.length, nutrition: summarizeNutrition(e.map(forSummary)), cost: estimateCost(e.map(forSummary)) }; }) });
});

const entryBody = z.object({
  day: dayZ.optional(), food_name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(),
  nutrition: nutritionSchema, nutrition_source: z.enum(["recorded", "estimated"]).nullable().optional(), cost: z.number().min(0).nullable().optional(),
  servings: z.number().positive().max(100).optional(), food_id: z.string().optional(), save_as_food: z.boolean().optional(),
});

async function nextOrder(env: Env, userId: string, day: string) {
  return (await one<{ n: number }>(env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_entries WHERE user_id=? AND day=?", userId, day))?.n ?? 0;
}

/** Add one item to a day. `save_as_food` also stores it under よく食べるもの. */
mealRoutes.post("/entries", async (c) => {
  const user = c.get("user");
  const b = entryBody.parse(await c.req.json());
  const day = b.day ?? jstDate();
  const servings = b.servings ?? 1;
  const base = b.nutrition && Object.keys(b.nutrition).length ? (b.nutrition as Nutrition) : null;
  const nutrition = servings === 1 ? base : scaleNutrition(base, 1, servings);
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,cost,servings,food_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    id, user.id, day, b.food_name, b.amount ?? null, b.unit ?? null, nutrition ? JSON.stringify(nutrition) : null,
    nutrition ? (b.nutrition_source ?? "recorded") : null, b.cost == null ? null : b.cost * servings, servings, b.food_id ?? null, await nextOrder(c.env, user.id, day));
  if (b.food_id) await run(c.env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=? AND user_id=?", b.food_id, user.id);
  else if (b.save_as_food) {
    const dup = await one<{ id: string }>(c.env.DB, "SELECT id FROM meal_foods WHERE user_id=? AND name=? AND archived_at IS NULL", user.id, b.food_name);
    if (dup) await run(c.env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=?", dup.id);
    else await run(c.env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,cost_per_serving,use_count,last_used_at) VALUES (?,?,?,?,?,?,?,?,1,datetime('now'))",
      newId(), user.id, b.food_name, b.amount ?? null, b.unit ?? null, base ? JSON.stringify(base) : null, base ? (b.nutrition_source ?? "recorded") : null, b.cost ?? null);
  }
  return c.json({ item: entryOut((await one<EntryRow>(c.env.DB, "SELECT * FROM meal_entries WHERE id=?", id))!), ...(await dayLog(c.env, user.id, day)) });
});

/** Add every member of a set to a day in one go. */
mealRoutes.post("/sets/:id/add", async (c) => {
  const user = c.get("user");
  const setId = c.req.param("id");
  const { day = jstDate() } = z.object({ day: dayZ.optional() }).parse(await c.req.json().catch(() => ({})));
  const set = await one<SetRow>(c.env.DB, "SELECT * FROM meal_sets WHERE id=? AND user_id=?", setId, user.id);
  if (!set) return c.json({ error: "not found" }, 404);
  const items = await all<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE set_id=? AND user_id=? ORDER BY sort_order, created_at", setId, user.id);
  if (!items.length) return c.json({ error: "このセットには食品が登録されていません" }, 400);
  let order = await nextOrder(c.env, user.id, day);
  await c.env.DB.batch(items.map((m) => c.env.DB.prepare("INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,cost,servings,set_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)")
    .bind(newId(), user.id, day, m.food_name, m.amount, m.unit, m.nutrition_json, m.nutrition_source, m.cost_per_serving, setId, order++)));
  return c.json({ added: items.length, ...(await dayLog(c.env, user.id, day)) });
});

mealRoutes.put("/entries/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<EntryRow>(c.env.DB, "SELECT * FROM meal_entries WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = entryBody.partial().parse(await c.req.json());
  let nJson = cur.nutrition_json, src = cur.nutrition_source;
  if (b.nutrition !== undefined) {
    if (b.nutrition && Object.keys(b.nutrition).length) { nJson = JSON.stringify(b.nutrition); src = b.nutrition_source ?? "recorded"; }
    else { nJson = null; src = null; }
  } else if (b.amount != null && cur.amount && parseNutrition(cur.nutrition_json)) {
    const scaled = scaleNutrition(parseNutrition(cur.nutrition_json), cur.amount, b.amount);
    if (scaled) { nJson = JSON.stringify(scaled); src = "estimated"; }
  }
  await run(c.env.DB, "UPDATE meal_entries SET food_name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, cost=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.food_name ?? cur.food_name, b.amount === undefined ? cur.amount : b.amount, b.unit === undefined ? cur.unit : b.unit, nJson, src, b.cost === undefined ? cur.cost : b.cost, id, user.id);
  return c.json({ ...(await dayLog(c.env, user.id, cur.day)) });
});

mealRoutes.delete("/entries/:id", async (c) => {
  const user = c.get("user");
  const cur = await one<{ day: string }>(c.env.DB, "SELECT day FROM meal_entries WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "DELETE FROM meal_entries WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ...(await dayLog(c.env, user.id, cur.day)) });
});

/** Clear a whole day (used by 記録をやり直す). */
mealRoutes.delete("/day/:day", async (c) => {
  const user = c.get("user");
  const day = dayZ.parse(c.req.param("day"));
  await run(c.env.DB, "DELETE FROM meal_entries WHERE user_id=? AND day=?", user.id, day);
  return c.json({ ...(await dayLog(c.env, user.id, day)) });
});

/* ---------------------------------------------------------------- saved foods */
const foodBody = z.object({
  name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(),
  nutrition: nutritionSchema, nutrition_source: z.enum(["recorded", "estimated"]).nullable().optional(), cost_per_serving: z.number().min(0).nullable().optional(),
});
mealRoutes.get("/foods", async (c) => {
  const user = c.get("user");
  const archived = c.req.query("archived") === "1";
  return c.json({ items: (await all<FoodRow>(c.env.DB, `SELECT * FROM meal_foods WHERE user_id=? AND archived_at IS ${archived ? "NOT" : ""} NULL ORDER BY use_count DESC, last_used_at DESC, created_at`, user.id)).map(foodOut) });
});
mealRoutes.post("/foods", async (c) => {
  const user = c.get("user");
  const b = foodBody.parse(await c.req.json());
  const hasN = b.nutrition && Object.keys(b.nutrition).length > 0;
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,cost_per_serving) VALUES (?,?,?,?,?,?,?,?)",
    id, user.id, b.name, b.amount ?? null, b.unit ?? null, hasN ? JSON.stringify(b.nutrition) : null, hasN ? (b.nutrition_source ?? "recorded") : null, b.cost_per_serving ?? null);
  return c.json({ item: foodOut((await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=?", id))!) });
});
mealRoutes.put("/foods/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<FoodRow & { archived_at: string | null }>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = foodBody.partial().extend({ archived: z.boolean().optional() }).parse(await c.req.json());
  let nJson = cur.nutrition_json, src = cur.nutrition_source;
  if (b.nutrition !== undefined) {
    if (b.nutrition && Object.keys(b.nutrition).length) { nJson = JSON.stringify(b.nutrition); src = b.nutrition_source ?? "recorded"; }
    else { nJson = null; src = null; }
  }
  await run(c.env.DB, "UPDATE meal_foods SET name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, cost_per_serving=?, archived_at=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.name ?? cur.name, b.amount === undefined ? cur.amount : b.amount, b.unit === undefined ? cur.unit : b.unit, nJson, src,
    b.cost_per_serving === undefined ? cur.cost_per_serving : b.cost_per_serving, b.archived === undefined ? cur.archived_at : (b.archived ? new Date().toISOString() : null), id, user.id);
  return c.json({ item: foodOut((await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=?", id))!) });
});
mealRoutes.delete("/foods/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM meal_foods WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- sets */
mealRoutes.get("/sets", async (c) => {
  const user = c.get("user");
  await migrateLegacy(c.env, user.id);
  const sets = await all<SetRow>(c.env.DB, "SELECT * FROM meal_sets WHERE user_id=? AND archived_at IS NULL ORDER BY sort_order, created_at", user.id);
  const members = await all<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NOT NULL ORDER BY sort_order, created_at", user.id);
  return c.json({ items: sets.map((s) => { const ms = members.filter((m) => m.set_id === s.id).map(memberOut); return { ...s, items: ms, nutrition: summarizeNutrition(ms), cost: estimateCost(ms) }; }) });
});
mealRoutes.post("/sets", async (c) => {
  const user = c.get("user");
  const b = z.object({ name: z.string().min(1).max(60) }).parse(await c.req.json());
  const id = newId();
  const order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_sets WHERE user_id=?", user.id))?.n ?? 0;
  await run(c.env.DB, "INSERT INTO meal_sets (id,user_id,name,sort_order) VALUES (?,?,?,?)", id, user.id, b.name, order);
  return c.json({ item: { id, name: b.name, sort_order: order, items: [] } });
});
mealRoutes.put("/sets/:id", async (c) => {
  const user = c.get("user");
  const b = z.object({ name: z.string().min(1).max(60).optional(), archived: z.boolean().optional() }).parse(await c.req.json());
  const cur = await one<SetRow & { archived_at: string | null }>(c.env.DB, "SELECT * FROM meal_sets WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE meal_sets SET name=?, archived_at=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.name ?? cur.name, b.archived === undefined ? cur.archived_at : (b.archived ? new Date().toISOString() : null), c.req.param("id"), user.id);
  return c.json({ ok: true });
});
mealRoutes.delete("/sets/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM meal_routines WHERE set_id=? AND user_id=?").bind(id, user.id),
    c.env.DB.prepare("DELETE FROM meal_sets WHERE id=? AND user_id=?").bind(id, user.id),
  ]);
  return c.json({ ok: true });
});

/** Add an item to a set (optionally from a saved food). */
mealRoutes.post("/sets/:id/items", async (c) => {
  const user = c.get("user");
  const setId = c.req.param("id");
  const set = await one<SetRow>(c.env.DB, "SELECT * FROM meal_sets WHERE id=? AND user_id=?", setId, user.id);
  if (!set) return c.json({ error: "not found" }, 404);
  const b = z.object({ food_id: z.string().optional() }).and(foodBody.partial()).parse(await c.req.json());
  let src: { name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null } | null = null;
  if (b.food_id) {
    const f = await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", b.food_id, user.id);
    if (!f) return c.json({ error: "food not found" }, 404);
    src = { name: f.name, amount: f.amount, unit: f.unit, nutrition_json: f.nutrition_json, nutrition_source: f.nutrition_source, cost_per_serving: f.cost_per_serving };
  } else {
    if (!b.name) return c.json({ error: "name is required" }, 400);
    const hasN = b.nutrition && Object.keys(b.nutrition).length > 0;
    src = { name: b.name, amount: b.amount ?? null, unit: b.unit ?? null, nutrition_json: hasN ? JSON.stringify(b.nutrition) : null, nutrition_source: hasN ? (b.nutrition_source ?? "recorded") : null, cost_per_serving: b.cost_per_serving ?? null };
  }
  const order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_routines WHERE set_id=?", setId))?.n ?? 0;
  await run(c.env.DB, "INSERT INTO meal_routines (id,user_id,slot,food_name,amount,unit,nutrition_json,nutrition_source,cost_per_serving,sort_order,set_id) VALUES (?,?,'other',?,?,?,?,?,?,?,?)",
    newId(), user.id, src.name, src.amount, src.unit, src.nutrition_json, src.nutrition_source, src.cost_per_serving, order, setId);
  return c.json({ ok: true });
});
mealRoutes.delete("/sets/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM meal_routines WHERE id=? AND set_id=? AND user_id=?", c.req.param("itemId"), c.req.param("id"), user.id);
  return c.json({ ok: true });
});
