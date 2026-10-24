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
import { summarizeNutrition, estimateCost, parseNutrition, scaleNutrition, withPfcEnergy, type Nutrition, type NutrientKey } from "./logic";
import { lookupFood, searchFoodTable, getTableFood, nutritionFor, FOOD_TABLE_SOURCE, type TableMatch } from "./food-table";

export const mealRoutes = new Hono<AppEnv>();

const nutritionSchema = z.record(z.string(), z.number()).nullable().optional();
const dayZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type FoodRow = { id: string; name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; nutrition_ref?: string | null; cost_per_serving: number | null; use_count: number; last_used_at: string | null };
type EntryRow = { id: string; day: string; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; nutrition_ref?: string | null; cost: number | null; servings: number; food_id: string | null; set_id: string | null; sort_order: number };
type SetRow = { id: string; name: string; sort_order: number };
type MemberRow = { id: string; set_id: string | null; food_name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; nutrition_ref?: string | null; cost_per_serving: number | null; sort_order: number; slot: string };

const refOut = (r: string | null | undefined) => { if (!r) return null; try { return JSON.parse(r) as { number: string; name: string; grams: number; grams_estimated?: boolean }; } catch { return null; } };
const foodOut = (f: FoodRow) => ({ ...f, nutrition: parseNutrition(f.nutrition_json), nutrition_ref: refOut(f.nutrition_ref) });
const entryOut = (e: EntryRow) => ({ ...e, nutrition: parseNutrition(e.nutrition_json), nutrition_ref: refOut(e.nutrition_ref) });
const memberOut = (m: MemberRow) => ({ ...m, nutrition: parseNutrition(m.nutrition_json), nutrition_ref: refOut(m.nutrition_ref) });
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

/**
 * Nutrition for a new item: values the user typed win (recorded); otherwise the 成分表 lookup
 * (table); otherwise nothing (unknown — never invented). `per` scales a per-serving value.
 */
async function resolveNutrition(env: Env, b: { food_name: string; amount?: number | null; unit?: string | null; nutrition?: Record<string, number> | null; nutrition_source?: string | null; nutrition_ref?: string | null; auto_nutrition?: boolean }) {
  if (b.nutrition && Object.keys(b.nutrition).length) {
    const source = b.nutrition_source ?? "recorded";
    return { nutrition: (source === "table" ? b.nutrition : withPfcEnergy(b.nutrition)) as Nutrition, source, ref: source === "table" ? (b.nutrition_ref ?? null) : (null as string | null) };
  }
  if (b.auto_nutrition === false) return { nutrition: null, source: null, ref: null };
  const r = await lookupFood(env, { name: b.food_name, amount: b.amount ?? null, unit: b.unit ?? null }).catch(() => null);
  if (!r?.match) return { nutrition: null, source: null, ref: null };
  return { nutrition: r.match.nutrition, source: "table", ref: JSON.stringify(refOf(r.match)) };
}
const refOf = (m: TableMatch) => ({ number: m.number, name: m.name, grams: m.grams, grams_estimated: m.grams_estimated });

/* ---------------------------------------------------------------- 日本食品標準成分表 */
/** Text search over the table (for the candidate picker). */
mealRoutes.get("/table/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 60);
  return c.json({ source: FOOD_TABLE_SOURCE, items: searchFoodTable(q, 20).map(({ food }) => ({ number: food.n, name: food.name, per100g: food.per100g })) });
});
/** Resolve a typed food + amount to a table food and grams (AI picks among real table foods). */
mealRoutes.post("/lookup", async (c) => {
  const b = z.object({ name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional() }).parse(await c.req.json());
  return c.json({ source: FOOD_TABLE_SOURCE, ...(await lookupFood(c.env, b)) });
});
/** Nutrition for a chosen table food and grams. */
mealRoutes.post("/table/compute", async (c) => {
  const b = z.object({ number: z.string().regex(/^\d{5}$/), grams: z.number().positive().max(5000) }).parse(await c.req.json());
  const f = getTableFood(b.number);
  if (!f) return c.json({ error: "not found" }, 404);
  return c.json({ number: f.n, name: f.name, grams: b.grams, nutrition: nutritionFor(f, b.grams) });
});

/** Recompute an entry / saved food / set item from the table. Recorded values need `confirm`. */
mealRoutes.post("/:kind/:id/table", async (c) => {
  const user = c.get("user");
  const kind = z.enum(["entry", "food", "item"]).parse(c.req.param("kind"));
  const id = c.req.param("id");
  const b = z.object({ number: z.string().regex(/^\d{5}$/).optional(), grams: z.number().positive().max(5000).optional(), confirm: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  const table = kind === "entry" ? "meal_entries" : kind === "food" ? "meal_foods" : "meal_routines";
  const nameCol = kind === "food" ? "name" : "food_name";
  const cur = await one<{ name: string; amount: number | null; unit: string | null; nutrition_source: string | null; servings?: number; day?: string }>(c.env.DB,
    `SELECT ${nameCol} AS name, amount, unit, nutrition_source${kind === "entry" ? ", servings, day" : ""} FROM ${table} WHERE id=? AND user_id=?`, id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  let match: TableMatch | null = null; let candidates: { number: string; name: string }[] = [];
  if (b.number && b.grams) {
    const f = getTableFood(b.number); if (!f) return c.json({ error: "not found" }, 404);
    match = { number: f.n, name: f.name, grams: b.grams, grams_estimated: false, nutrition: nutritionFor(f, b.grams) };
  } else {
    const r = await lookupFood(c.env, { name: cur.name, amount: cur.amount, unit: cur.unit });
    match = r.match; candidates = r.candidates;
  }
  if (!match) return c.json({ applied: false, reason: "no_match", candidates });
  if (cur.nutrition_source === "recorded" && !b.confirm) return c.json({ applied: false, reason: "recorded", match, candidates });
  const servings = kind === "entry" ? (cur.servings ?? 1) : 1;
  const nutrition = servings === 1 ? match.nutrition : scaleNutrition(match.nutrition, 1, servings);
  await run(c.env.DB, `UPDATE ${table} SET nutrition_json=?, nutrition_source='table', nutrition_ref=?, updated_at=datetime('now') WHERE id=? AND user_id=?`,
    JSON.stringify(nutrition), JSON.stringify(refOf(match)), id, user.id);
  return c.json({ applied: true, match, ...(kind === "entry" && cur.day ? await dayLog(c.env, user.id, cur.day) : {}) });
});

/** Fill every saved food that has no recorded values from the table (skips anything already recorded). */
mealRoutes.post("/foods/recalc", async (c) => {
  const user = c.get("user");
  const foods = await all<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE user_id=? AND archived_at IS NULL AND (nutrition_source IS NULL OR nutrition_source<>'recorded')", user.id);
  const results: { name: string; matched: string | null; grams: number | null }[] = [];
  for (const f of foods) {
    const r = await lookupFood(c.env, { name: f.name, amount: f.amount, unit: f.unit }).catch(() => null);
    if (r?.match) {
      await run(c.env.DB, "UPDATE meal_foods SET nutrition_json=?, nutrition_source='table', nutrition_ref=?, updated_at=datetime('now') WHERE id=?", JSON.stringify(r.match.nutrition), JSON.stringify(refOf(r.match)), f.id);
      results.push({ name: f.name, matched: r.match.name, grams: r.match.grams });
    } else results.push({ name: f.name, matched: null, grams: null });
  }
  // Set members are copies of foods; recompute those that were not typed in by hand, too.
  const members = await all<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NOT NULL AND (nutrition_source IS NULL OR nutrition_source<>'recorded')", user.id);
  let membersUpdated = 0;
  for (const m of members) {
    const r = await lookupFood(c.env, { name: m.food_name, amount: m.amount, unit: m.unit }).catch(() => null);
    if (!r?.match) continue;
    await run(c.env.DB, "UPDATE meal_routines SET nutrition_json=?, nutrition_source='table', nutrition_ref=?, updated_at=datetime('now') WHERE id=?", JSON.stringify(r.match.nutrition), JSON.stringify(refOf(r.match)), m.id);
    membersUpdated++;
  }
  return c.json({ updated: results.filter((x) => x.matched).length, skipped: results.filter((x) => !x.matched).length, set_items_updated: membersUpdated, results });
});

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
  nutrition: nutritionSchema, nutrition_source: z.enum(["recorded", "estimated", "table"]).nullable().optional(), nutrition_ref: z.string().max(400).nullable().optional(),
  cost: z.number().min(0).nullable().optional(), servings: z.number().positive().max(100).optional(), food_id: z.string().optional(), save_as_food: z.boolean().optional(),
  auto_nutrition: z.boolean().optional(),
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
  // From a saved food the values are copied as they are; a new name is looked up in the 成分表.
  const resolved = b.food_id
    ? { nutrition: b.nutrition && Object.keys(b.nutrition).length ? (b.nutrition as Nutrition) : null, source: b.nutrition_source ?? null, ref: b.nutrition_ref ?? null }
    : await resolveNutrition(c.env, b);
  const base = resolved.nutrition;
  const nutrition = servings === 1 ? base : scaleNutrition(base, 1, servings);
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,food_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, user.id, day, b.food_name, b.amount ?? null, b.unit ?? null, nutrition ? JSON.stringify(nutrition) : null,
    nutrition ? (resolved.source ?? "recorded") : null, nutrition ? resolved.ref : null, b.cost == null ? null : b.cost * servings, servings, b.food_id ?? null, await nextOrder(c.env, user.id, day));
  if (b.food_id) await run(c.env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=? AND user_id=?", b.food_id, user.id);
  else if (b.save_as_food) {
    const dup = await one<{ id: string }>(c.env.DB, "SELECT id FROM meal_foods WHERE user_id=? AND name=? AND archived_at IS NULL", user.id, b.food_name);
    if (dup) await run(c.env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=?", dup.id);
    else await run(c.env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,use_count,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now'))",
      newId(), user.id, b.food_name, b.amount ?? null, b.unit ?? null, base ? JSON.stringify(base) : null, base ? (resolved.source ?? "recorded") : null, base ? resolved.ref : null, b.cost ?? null);
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
  await c.env.DB.batch(items.map((m) => c.env.DB.prepare("INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,set_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)")
    .bind(newId(), user.id, day, m.food_name, m.amount, m.unit, m.nutrition_json, m.nutrition_source, m.nutrition_ref ?? null, m.cost_per_serving, setId, order++)));
  return c.json({ added: items.length, ...(await dayLog(c.env, user.id, day)) });
});

mealRoutes.put("/entries/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<EntryRow>(c.env.DB, "SELECT * FROM meal_entries WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = entryBody.partial().parse(await c.req.json());
  let nJson = cur.nutrition_json, src = cur.nutrition_source, ref = cur.nutrition_ref ?? null;
  if (b.nutrition !== undefined) {
    if (b.nutrition && Object.keys(b.nutrition).length) { src = b.nutrition_source ?? "recorded"; nJson = JSON.stringify(src === "table" ? b.nutrition : withPfcEnergy(b.nutrition)); ref = src === "table" ? (b.nutrition_ref ?? null) : null; }
    else { nJson = null; src = null; ref = null; }
  } else if (b.amount != null && cur.amount && parseNutrition(cur.nutrition_json)) {
    const scaled = scaleNutrition(parseNutrition(cur.nutrition_json), cur.amount, b.amount);
    if (scaled) {
      nJson = JSON.stringify(scaled);
      // table values scale exactly with grams; anything else becomes an estimate
      if (src === "table" && ref) { const r = refOut(ref); if (r && cur.unit && /^(g|ｇ|グラム|ml|mL|cc)$/.test(cur.unit)) ref = JSON.stringify({ ...r, grams: b.amount }); else src = "estimated"; }
      else src = "estimated";
    }
  }
  await run(c.env.DB, "UPDATE meal_entries SET food_name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, nutrition_ref=?, cost=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.food_name ?? cur.food_name, b.amount === undefined ? cur.amount : b.amount, b.unit === undefined ? cur.unit : b.unit, nJson, src, ref, b.cost === undefined ? cur.cost : b.cost, id, user.id);
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
  nutrition: nutritionSchema, nutrition_source: z.enum(["recorded", "estimated", "table"]).nullable().optional(), nutrition_ref: z.string().max(400).nullable().optional(),
  cost_per_serving: z.number().min(0).nullable().optional(), auto_nutrition: z.boolean().optional(),
});
mealRoutes.get("/foods", async (c) => {
  const user = c.get("user");
  const archived = c.req.query("archived") === "1";
  return c.json({ items: (await all<FoodRow>(c.env.DB, `SELECT * FROM meal_foods WHERE user_id=? AND archived_at IS ${archived ? "NOT" : ""} NULL ORDER BY use_count DESC, last_used_at DESC, created_at`, user.id)).map(foodOut) });
});
mealRoutes.post("/foods", async (c) => {
  const user = c.get("user");
  const b = foodBody.parse(await c.req.json());
  const r = b.nutrition_ref && b.nutrition ? { nutrition: b.nutrition as Nutrition, source: b.nutrition_source ?? "table", ref: b.nutrition_ref } : await resolveNutrition(c.env, { food_name: b.name, ...b });
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving) VALUES (?,?,?,?,?,?,?,?,?)",
    id, user.id, b.name, b.amount ?? null, b.unit ?? null, r.nutrition ? JSON.stringify(r.nutrition) : null, r.nutrition ? r.source : null, r.nutrition ? r.ref : null, b.cost_per_serving ?? null);
  return c.json({ item: foodOut((await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=?", id))!) });
});
mealRoutes.put("/foods/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<FoodRow & { archived_at: string | null }>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = foodBody.partial().extend({ archived: z.boolean().optional() }).parse(await c.req.json());
  let nJson = cur.nutrition_json, src = cur.nutrition_source;
  let ref = cur.nutrition_ref ?? null;
  if (b.nutrition !== undefined) {
    if (b.nutrition && Object.keys(b.nutrition).length) { src = b.nutrition_source ?? "recorded"; nJson = JSON.stringify(src === "table" ? b.nutrition : withPfcEnergy(b.nutrition)); ref = src === "table" ? (b.nutrition_ref ?? null) : null; }
    else { nJson = null; src = null; ref = null; }
  }
  await run(c.env.DB, "UPDATE meal_foods SET name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, nutrition_ref=?, cost_per_serving=?, archived_at=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.name ?? cur.name, b.amount === undefined ? cur.amount : b.amount, b.unit === undefined ? cur.unit : b.unit, nJson, src, ref,
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
  type Body = typeof b;
  let src: { name: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; cost_per_serving: number | null; nutrition_ref?: string | null } | null = null;
  if (b.food_id) {
    const f = await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", b.food_id, user.id);
    if (!f) return c.json({ error: "food not found" }, 404);
    src = { name: f.name, amount: f.amount, unit: f.unit, nutrition_json: f.nutrition_json, nutrition_source: f.nutrition_source, cost_per_serving: f.cost_per_serving, nutrition_ref: f.nutrition_ref ?? null };
  } else {
    if (!b.name) return c.json({ error: "name is required" }, 400);
    const r = await resolveNutrition(c.env, { food_name: b.name, ...b });
    src = { name: b.name, amount: b.amount ?? null, unit: b.unit ?? null, nutrition_json: r.nutrition ? JSON.stringify(r.nutrition) : null, nutrition_source: r.nutrition ? r.source : null, cost_per_serving: b.cost_per_serving ?? null, nutrition_ref: r.nutrition ? r.ref : null };
  }
  const order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_routines WHERE set_id=?", setId))?.n ?? 0;
  await run(c.env.DB, "INSERT INTO meal_routines (id,user_id,slot,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,sort_order,set_id) VALUES (?,?,'other',?,?,?,?,?,?,?,?,?)",
    newId(), user.id, src.name, src.amount, src.unit, src.nutrition_json, src.nutrition_source, src.nutrition_ref ?? null, src.cost_per_serving, order, setId);
  return c.json({ ok: true });
});
mealRoutes.delete("/sets/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM meal_routines WHERE id=? AND set_id=? AND user_id=?", c.req.param("itemId"), c.req.param("id"), user.id);
  return c.json({ ok: true });
});
