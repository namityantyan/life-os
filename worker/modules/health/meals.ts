/**
 * Meals: a daily log of what was actually eaten (JST day), filled in with one tap from saved foods
 * ("よく食べるもの") or saved sets ("セット"). Nutrition and cost are copied into each entry, so editing a
 * saved food later never rewrites past days.
 *
 * Writes never wait for the AI. A new item without values is stored at once; the client then asks
 * POST /:kind/:id/table to match it to the 成分表 (bounded AI call) and shows progress meanwhile.
 * Stored nutrition is per serving × servings; `cost` on an entry is the total (per serving × servings).
 *
 * Legacy: meal_routines rows are the members of a set (set_id). Rows from the previous
 * "routine = plan" model are migrated once, on first read, into a set plus saved foods.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, getSetting, setSetting, jstDate } from "../../core/db";
import { chatJson } from "../../core/ai";
import {
  NUTRIENT_KEYS, summarizeNutrition, estimateCost, parseNutrition, withPfcEnergy, normalizeMealProposal, planNutritionEdit,
  type Nutrition, type NutrientKey, type NutritionEdit, type StoredNutrition, type TableRef, type TableCompute,
} from "./logic";
import { lookupFood, searchFoodTable, getTableFood, nutritionFor, candidateOf, FOOD_TABLE_SOURCE, LOOKUP_TIMEOUT_MS, type TableMatch } from "./food-table";

export const mealRoutes = new Hono<AppEnv>();

const dayZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Only known nutrient keys with finite values survive. */
const nutritionZ = z.record(z.string(), z.number().nullable()).nullable().optional().transform((r) => {
  if (r == null) return r;
  const out: Nutrition = {};
  for (const k of NUTRIENT_KEYS) { const v = r[k]; if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v; }
  return out;
});
const tableZ = z.object({ number: z.string().regex(/^\d{5}$/), grams: z.number().positive().max(5000), grams_estimated: z.boolean().optional() }).nullable().optional();
const nutritionFields = {
  nutrition: nutritionZ, nutrition_source: z.enum(["recorded", "estimated", "table"]).nullable().optional(),
  nutrition_ref: z.string().max(400).nullable().optional(), table: tableZ,
};

type Row = { id: string; amount: number | null; unit: string | null; nutrition_json: string | null; nutrition_source: string | null; nutrition_ref?: string | null; updated_at?: string };
type FoodRow = Row & { name: string; cost_per_serving: number | null; use_count: number; last_used_at: string | null; archived_at?: string | null };
type EntryRow = Row & { day: string; food_name: string; cost: number | null; servings: number; food_id: string | null; set_id: string | null; sort_order: number };
type SetRow = { id: string; name: string; sort_order: number; archived_at?: string | null };
type MemberRow = Row & { set_id: string | null; food_name: string; cost_per_serving: number | null; sort_order: number; slot: string };

const refOut = (r: string | null | undefined): TableRef | null => { if (!r) return null; try { return JSON.parse(r) as TableRef; } catch { return null; } };
const foodOut = (f: FoodRow) => ({ ...f, nutrition: parseNutrition(f.nutrition_json), nutrition_ref: refOut(f.nutrition_ref) });
const entryOut = (e: EntryRow) => ({ ...e, nutrition: parseNutrition(e.nutrition_json), nutrition_ref: refOut(e.nutrition_ref) });
const memberOut = (m: MemberRow) => ({ ...m, nutrition: parseNutrition(m.nutrition_json), nutrition_ref: refOut(m.nutrition_ref) });
/** Entries carry an absolute cost; summarizeNutrition/estimateCost expect `cost_per_serving`. */
const forSummary = (e: Pick<EntryRow, "nutrition_json" | "nutrition_source" | "cost">) => ({ nutrition_json: e.nutrition_json, nutrition_source: e.nutrition_source, cost_per_serving: e.cost });
const stored = (r: Row): StoredNutrition => ({ nutrition: parseNutrition(r.nutrition_json), source: r.nutrition_source, ref: refOut(r.nutrition_ref) });
const sqlN = (s: StoredNutrition) => [s.nutrition ? JSON.stringify(s.nutrition) : null, s.nutrition ? s.source : null, s.nutrition && s.ref ? JSON.stringify(s.ref) : null] as const;
const compute: TableCompute = (number, grams) => { const f = getTableFood(number); return f ? { name: f.name, nutrition: nutritionFor(f, grams) } : null; };
const refOf = (m: TableMatch): TableRef => ({ number: m.number, name: m.name, grams: m.grams, grams_estimated: m.grams_estimated });
/** Client body → NutritionEdit (`undefined` = keep what is stored). */
function editOf(b: { nutrition?: Nutrition | null; nutrition_source?: string | null; nutrition_ref?: string | null; table?: { number: string; grams: number; grams_estimated?: boolean } | null }): NutritionEdit {
  if (b.table) return { table: b.table };
  if (b.nutrition !== undefined) return { nutrition: b.nutrition, source: (b.nutrition_source ?? "recorded") as NutritionEdit["source"], ref: refOut(b.nutrition_ref) };
  return {};
}
const EMPTY: StoredNutrition = { nutrition: null, source: null, ref: null };

const SLOT_SET_NAME: Record<string, string> = { breakfast: "いつもの朝食", lunch: "いつもの昼食", dinner: "いつもの夕食", snack: "いつもの間食" };

/** One-time migration from the old routine model: each slot becomes a set, each row also a saved food. */
async function migrateLegacy(env: Env, userId: string): Promise<void> {
  const orphans = await all<MemberRow>(env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NULL ORDER BY CASE slot WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'dinner' THEN 2 ELSE 3 END, sort_order, created_at", userId);
  if (!orphans.length) return;
  const known = new Set((await all<{ name: string }>(env.DB, "SELECT name FROM meal_foods WHERE user_id=?", userId)).map((f) => f.name));
  const stmts: D1PreparedStatement[] = [];
  const setIds = new Map<string, string>();
  let order = (await one<{ n: number }>(env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_sets WHERE user_id=?", userId))?.n ?? 0;
  for (const m of orphans) {
    if (!setIds.has(m.slot)) {
      const sid = newId(); setIds.set(m.slot, sid);
      stmts.push(env.DB.prepare("INSERT INTO meal_sets (id,user_id,name,sort_order) VALUES (?,?,?,?)").bind(sid, userId, SLOT_SET_NAME[m.slot] ?? "いつもの食事", order++));
    }
    stmts.push(env.DB.prepare("UPDATE meal_routines SET set_id=? WHERE id=?").bind(setIds.get(m.slot), m.id));
    if (!known.has(m.food_name)) {
      known.add(m.food_name);
      stmts.push(env.DB.prepare("INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(newId(), userId, m.food_name, m.amount, m.unit, m.nutrition_json, m.nutrition_source, m.nutrition_ref ?? null, m.cost_per_serving));
    }
  }
  await env.DB.batch(stmts);
}

export async function dayLog(env: Env, userId: string, day: string) {
  const [entries, targets] = await Promise.all([
    all<EntryRow>(env.DB, "SELECT * FROM meal_entries WHERE user_id=? AND day=? ORDER BY sort_order, created_at", userId, day),
    getSetting<Partial<Record<NutrientKey, number>>>(env, userId, "nutrition_targets", {}),
  ]);
  return { day, entries: entries.map(entryOut), summary: { nutrition: summarizeNutrition(entries.map(forSummary)), cost: estimateCost(entries.map(forSummary)), targets } };
}

async function loadSets(env: Env, userId: string) {
  const [sets, members] = await Promise.all([
    all<SetRow>(env.DB, "SELECT id,name,sort_order FROM meal_sets WHERE user_id=? AND archived_at IS NULL ORDER BY sort_order, created_at", userId),
    all<MemberRow>(env.DB, "SELECT * FROM meal_routines WHERE user_id=? AND set_id IS NOT NULL ORDER BY sort_order, created_at", userId),
  ]);
  const by = new Map<string, MemberRow[]>();
  for (const m of members) by.set(m.set_id!, [...(by.get(m.set_id!) ?? []), m]);
  return sets.map((s) => { const ms = by.get(s.id) ?? []; return { ...s, items: ms.map(memberOut), nutrition: summarizeNutrition(ms), cost: estimateCost(ms) }; });
}
const loadFoods = (env: Env, userId: string, archived = false) =>
  all<FoodRow>(env.DB, `SELECT * FROM meal_foods WHERE user_id=? AND archived_at IS ${archived ? "NOT" : ""} NULL ORDER BY use_count DESC, last_used_at DESC, created_at`, userId);

async function nextOrder(env: Env, userId: string, day: string) {
  return (await one<{ n: number }>(env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_entries WHERE user_id=? AND day=?", userId, day))?.n ?? 0;
}
const getEntry = async (env: Env, userId: string, id: string) => { const r = await one<EntryRow>(env.DB, "SELECT * FROM meal_entries WHERE id=? AND user_id=?", id, userId); return r ? entryOut(r) : null; };

/** Find or create a saved food by name (used by 「よく食べるものに登録」). Returns its id. */
async function upsertFood(env: Env, userId: string, f: { name: string; amount: number | null; unit: string | null; per: StoredNutrition; cost: number | null }) {
  const dup = await one<{ id: string; nutrition_json: string | null }>(env.DB, "SELECT id,nutrition_json FROM meal_foods WHERE user_id=? AND name=? AND archived_at IS NULL", userId, f.name);
  if (dup) {
    await run(env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=?", dup.id);
    return dup.id;
  }
  const id = newId();
  await run(env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,use_count,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,1,datetime('now'))",
    id, userId, f.name, f.amount, f.unit, ...sqlN(f.per), f.cost);
  return id;
}

/* ---------------------------------------------------------------- 日本食品標準成分表 */
/** Text search over the table (instant, no AI). per100g lets the client preview any grams locally. */
mealRoutes.get("/table/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 60);
  return c.json({ source: FOOD_TABLE_SOURCE, items: searchFoodTable(q, 20).map(({ food }) => candidateOf(food)) });
});
/** Resolve a typed food + amount to a table food and grams (AI picks among real table foods; bounded). */
mealRoutes.post("/lookup", async (c) => {
  const b = z.object({ name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional() }).parse(await c.req.json());
  return c.json({ source: FOOD_TABLE_SOURCE, ...(await lookupFood(c.env, b)) });
});
/** Nutrition for a chosen table food and grams. */
mealRoutes.post("/table/compute", async (c) => {
  const b = z.object({ number: z.string().regex(/^\d{5}$/), grams: z.number().positive().max(5000) }).parse(await c.req.json());
  const f = getTableFood(b.number);
  if (!f) return c.json({ error: "成分表に無い食品番号です" }, 404);
  return c.json({ number: f.n, name: f.name, grams: b.grams, nutrition: nutritionFor(f, b.grams) });
});
/** AI guess for foods that are not in the table. Preview only: the client shows it as 推定 and saves it explicitly. */
mealRoutes.post("/estimate", async (c) => {
  const b = z.object({ name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional() }).parse(await c.req.json());
  const prompt = `次の食品1回分の栄養を推定し、JSONのみで返してください。キーは ${NUTRIENT_KEYS.join(", ")}。不明なキーは省略。値は数値のみ（_ug は µg）。\n食品: ${b.name}${b.amount != null ? ` ${b.amount}${b.unit ?? ""}` : ""}`;
  const r = await chatJson<Record<string, unknown>>(c.env, [{ role: "system", content: "あなたは管理栄養士です。JSONオブジェクトのみを出力します。" }, { role: "user", content: prompt }], {}, { timeoutMs: LOOKUP_TIMEOUT_MS, maxTokens: 500 });
  const est = parseNutrition(JSON.stringify(r.data));
  return c.json({ estimate: est ? withPfcEnergy(est) : null, provider: r.provider });
});

const KIND = { entry: { table: "meal_entries", name: "food_name" }, food: { table: "meal_foods", name: "name" }, item: { table: "meal_routines", name: "food_name" } } as const;
/**
 * Fill an entry / saved food / set member from the 成分表.
 * - { number, grams }: that food (instant). Recorded values need `confirm`.
 * - otherwise the AI picks (bounded). With `auto`, it only fills a row that still has no values or an AI guess,
 *   and only if nobody edited the row meanwhile — so a quick edit is never overwritten by a late lookup.
 */
mealRoutes.post("/:kind/:id/table", async (c) => {
  const user = c.get("user");
  const kind = z.enum(["entry", "food", "item"]).parse(c.req.param("kind"));
  const id = c.req.param("id");
  const b = z.object({ number: z.string().regex(/^\d{5}$/).optional(), grams: z.number().positive().max(5000).optional(), confirm: z.boolean().optional(), auto: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  const { table, name } = KIND[kind];
  const cur = await one<Row & { name: string; servings?: number; food_id?: string | null }>(c.env.DB, `SELECT *, ${name} AS name FROM ${table} WHERE id=? AND user_id=?`, id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  let match: TableMatch | null = null, candidates: ReturnType<typeof candidateOf>[] = [], note: string | undefined;
  if (b.number && b.grams) {
    const f = getTableFood(b.number); if (!f) return c.json({ error: "成分表に無い食品番号です" }, 404);
    match = { number: f.n, name: f.name, grams: b.grams, grams_estimated: false, nutrition: nutritionFor(f, b.grams) };
  } else {
    if (b.auto && cur.nutrition_source && cur.nutrition_source !== "estimated") return c.json({ applied: false, reason: "has_values" });
    const r = await lookupFood(c.env, { name: cur.name, amount: cur.amount, unit: cur.unit }).catch(() => null);
    match = r?.match ?? null; candidates = r?.candidates ?? []; note = r?.note ?? (r ? undefined : "成分表を検索できませんでした");
  }
  if (!match) return c.json({ applied: false, reason: "no_match", candidates, note });
  if (cur.nutrition_source === "recorded" && !b.confirm && !b.auto) return c.json({ applied: false, reason: "recorded", match, candidates });
  const servings = kind === "entry" ? (cur.servings ?? 1) : 1;
  const next = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings, stored: EMPTY }, { amount: cur.amount, unit: cur.unit, servings }, { table: { number: match.number, grams: match.grams, grams_estimated: match.grams_estimated } }, compute);
  const guard = b.auto ? " AND (nutrition_source IS NULL OR nutrition_source='estimated') AND updated_at=?" : "";
  const res = await run(c.env.DB, `UPDATE ${table} SET nutrition_json=?, nutrition_source=?, nutrition_ref=?, updated_at=datetime('now') WHERE id=? AND user_id=?${guard}`,
    ...sqlN(next), id, user.id, ...(b.auto ? [cur.updated_at] : []));
  if (b.auto && !(res.meta?.changes ?? 1)) return c.json({ applied: false, reason: "edited" });
  // A saved food created together with this entry (「よく食べるものに登録」) gets the same values while it has none.
  if (kind === "entry" && cur.food_id) {
    const per = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings: 1, stored: EMPTY }, { amount: cur.amount, unit: cur.unit, servings: 1 }, { table: { number: match.number, grams: match.grams, grams_estimated: match.grams_estimated } }, compute);
    await run(c.env.DB, "UPDATE meal_foods SET nutrition_json=?, nutrition_source=?, nutrition_ref=?, updated_at=datetime('now') WHERE id=? AND user_id=? AND nutrition_json IS NULL", ...sqlN(per), cur.food_id, user.id);
  }
  const row = await one<Row>(c.env.DB, `SELECT * FROM ${table} WHERE id=?`, id);
  const item = kind === "entry" ? entryOut(row as EntryRow) : kind === "food" ? foodOut(row as FoodRow) : memberOut(row as MemberRow);
  return c.json({ applied: true, match: { ...refOf(match), nutrition: match.nutrition }, candidates, item });
});

/* ---------------------------------------------------------------- day log */
mealRoutes.get("/day", async (c) => {
  const user = c.get("user");
  const day = dayZ.parse(c.req.query("day") || jstDate());
  await migrateLegacy(c.env, user.id);
  const [log, foods, sets] = await Promise.all([dayLog(c.env, user.id, day), loadFoods(c.env, user.id), loadSets(c.env, user.id)]);
  return c.json({ ...log, foods: foods.map(foodOut), sets });
});
mealRoutes.get("/summary", async (c) => c.json((await dayLog(c.env, c.get("user").id, jstDate())).summary));

/**
 * Per-day totals. `?to=YYYY-MM-DD&n=7` → every calendar day of that range (empty days included);
 * `?limit=14` → the most recent days that have entries.
 */
mealRoutes.get("/days", async (c) => {
  const user = c.get("user");
  const to = c.req.query("to");
  let days: string[];
  if (to) {
    const end = dayZ.parse(to); const n = Math.min(Math.max(Number(c.req.query("n") ?? 7) || 7, 1), 62);
    days = Array.from({ length: n }, (_, i) => new Date(Date.parse(end + "T00:00:00Z") - (n - 1 - i) * 86400e3).toISOString().slice(0, 10));
  } else {
    const limit = Math.min(Number(c.req.query("limit") ?? 14) || 14, 90);
    days = (await all<{ day: string }>(c.env.DB, "SELECT DISTINCT day FROM meal_entries WHERE user_id=? ORDER BY day DESC LIMIT ?", user.id, limit)).map((d) => d.day);
  }
  if (!days.length) return c.json({ items: [] });
  const rows = await all<Pick<EntryRow, "day" | "nutrition_json" | "nutrition_source" | "cost">>(c.env.DB,
    "SELECT day,nutrition_json,nutrition_source,cost FROM meal_entries WHERE user_id=? AND day>=? AND day<=?", user.id, [...days].sort()[0], [...days].sort().at(-1));
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.day, [...(by.get(r.day) ?? []), r]);
  return c.json({ items: days.map((d) => { const e = by.get(d) ?? []; return { day: d, count: e.length, nutrition: summarizeNutrition(e.map(forSummary)), cost: estimateCost(e.map(forSummary)) }; }) });
});

const entryBody = z.object({
  day: dayZ.optional(), food_name: z.string().trim().min(1).max(120), amount: z.number().positive().max(100000).nullable().optional(), unit: z.string().trim().max(20).nullable().optional(),
  ...nutritionFields,
  cost: z.number().min(0).max(1e6).nullable().optional(), servings: z.number().positive().max(100).optional(), food_id: z.string().optional(), save_as_food: z.boolean().optional(),
  auto_nutrition: z.boolean().optional(), // accepted for older clients; lookups are always the client's separate call now
});

/**
 * Add one item to a day — instant, never waits for the AI. From a saved food the stored values are
 * copied server-side. Without values the response says `needs_lookup`, and the client fills it via
 * POST /entry/:id/table { auto: true }. `save_as_food` also stores it under よく食べるもの.
 */
mealRoutes.post("/entries", async (c) => {
  const user = c.get("user");
  const b = entryBody.extend({ food_name: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
  if (!b.food_name && !b.food_id) return c.json({ error: "食べたものを入力してください" }, 400);
  const day = b.day ?? jstDate();
  const servings = b.servings ?? 1;
  let name = b.food_name ?? "", amount = b.amount ?? null, unit = b.unit || null, costPer = b.cost ?? null, foodId: string | null = null;
  let per: StoredNutrition = EMPTY;
  const edit = editOf(b);
  if (b.food_id) {
    const f = await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", b.food_id, user.id);
    if (!f) return c.json({ error: "よく食べるものが見つかりません" }, 404);
    foodId = f.id; name = b.food_name ?? f.name;
    if (b.amount === undefined) { amount = f.amount; unit = f.unit; }
    if (b.cost === undefined) costPer = f.cost_per_serving;
    per = edit.table || edit.nutrition !== undefined ? planNutritionEdit({ amount, unit, servings: 1, stored: EMPTY }, { amount, unit, servings: 1 }, edit, compute)
      // a different unit ("2個" for a food saved as "100g") cannot be rescaled: keep the saved values
      : planNutritionEdit({ amount: f.amount, unit: f.unit, servings: 1, stored: stored(f) }, { amount: (unit ?? null) === (f.unit ?? null) ? amount : f.amount, unit: f.unit, servings: 1 }, {}, compute);
    await run(c.env.DB, "UPDATE meal_foods SET use_count=use_count+1, last_used_at=datetime('now') WHERE id=?", f.id);
  } else {
    per = planNutritionEdit({ amount, unit, servings: 1, stored: EMPTY }, { amount, unit, servings: 1 }, edit, compute);
    if (b.save_as_food) foodId = await upsertFood(c.env, user.id, { name, amount, unit, per, cost: costPer });
  }
  const total = planNutritionEdit({ amount, unit, servings: 1, stored: per }, { amount, unit, servings }, {}, compute);
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,food_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, user.id, day, name, amount, unit, ...sqlN(total), costPer == null ? null : Math.round(costPer * servings * 100) / 100, servings, foodId, await nextOrder(c.env, user.id, day));
  const item = (await getEntry(c.env, user.id, id))!;
  return c.json({ item, needs_lookup: !item.nutrition, ...(await dayLog(c.env, user.id, day)) });
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
  const ids = items.map(() => newId());
  await c.env.DB.batch(items.map((m, i) => c.env.DB.prepare("INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,set_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)")
    .bind(ids[i], user.id, day, m.food_name, m.amount, m.unit, m.nutrition_json, m.nutrition_source, m.nutrition_ref ?? null, m.cost_per_serving, setId, order++)));
  const log = await dayLog(c.env, user.id, day);
  return c.json({ added: items.length, items: log.entries.filter((e) => ids.includes(e.id)), ...log });
});

/** Edit an entry. Values in `nutrition` / `table` are per serving. Instant (no AI). */
mealRoutes.put("/entries/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<EntryRow>(c.env.DB, "SELECT * FROM meal_entries WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = entryBody.partial().parse(await c.req.json());
  const next = { amount: b.amount === undefined ? cur.amount : b.amount, unit: b.unit === undefined ? cur.unit : (b.unit || null), servings: b.servings ?? cur.servings };
  let n: StoredNutrition;
  try { n = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings: cur.servings, stored: stored(cur) }, next, editOf(b), compute); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
  // cost: a new per-serving value, or the stored total rescaled to the new servings
  const cost = b.cost !== undefined ? (b.cost == null ? null : Math.round(b.cost * next.servings * 100) / 100)
    : cur.cost == null ? null : Math.round((cur.cost / (cur.servings || 1)) * next.servings * 100) / 100;
  await run(c.env.DB, "UPDATE meal_entries SET food_name=?, amount=?, unit=?, servings=?, nutrition_json=?, nutrition_source=?, nutrition_ref=?, cost=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.food_name ?? cur.food_name, next.amount, next.unit, next.servings, ...sqlN(n), cost, id, user.id);
  let foodId = cur.food_id;
  if (b.save_as_food && !cur.food_id) {
    const per = planNutritionEdit({ amount: next.amount, unit: next.unit, servings: next.servings, stored: n }, { ...next, servings: 1 }, {}, compute);
    foodId = await upsertFood(c.env, user.id, { name: b.food_name ?? cur.food_name, amount: next.amount, unit: next.unit, per, cost: cost == null ? null : cost / next.servings });
    await run(c.env.DB, "UPDATE meal_entries SET food_id=? WHERE id=?", foodId, id);
  }
  return c.json({ item: await getEntry(c.env, user.id, id), saved_food_id: foodId !== cur.food_id ? foodId : null, ...(await dayLog(c.env, user.id, cur.day)) });
});

mealRoutes.delete("/entries/:id", async (c) => {
  const user = c.get("user");
  const cur = await one<{ day: string }>(c.env.DB, "SELECT day FROM meal_entries WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "DELETE FROM meal_entries WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ...(await dayLog(c.env, user.id, cur.day)) });
});

/** Clear a whole day. */
mealRoutes.delete("/day/:day", async (c) => {
  const user = c.get("user");
  const day = dayZ.parse(c.req.param("day"));
  await run(c.env.DB, "DELETE FROM meal_entries WHERE user_id=? AND day=?", user.id, day);
  return c.json({ ...(await dayLog(c.env, user.id, day)) });
});

/* ---------------------------------------------------------------- saved foods */
const foodBody = z.object({
  name: z.string().trim().min(1).max(120), amount: z.number().positive().max(100000).nullable().optional(), unit: z.string().trim().max(20).nullable().optional(),
  ...nutritionFields, cost_per_serving: z.number().min(0).max(1e6).nullable().optional(), auto_nutrition: z.boolean().optional(),
});
mealRoutes.get("/foods", async (c) => c.json({ items: (await loadFoods(c.env, c.get("user").id, c.req.query("archived") === "1")).map(foodOut) }));
mealRoutes.post("/foods", async (c) => {
  const user = c.get("user");
  const b = foodBody.parse(await c.req.json());
  const n = planNutritionEdit({ amount: b.amount ?? null, unit: b.unit || null, servings: 1, stored: EMPTY }, { amount: b.amount ?? null, unit: b.unit || null, servings: 1 }, editOf(b), compute);
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_foods (id,user_id,name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving) VALUES (?,?,?,?,?,?,?,?,?)",
    id, user.id, b.name, b.amount ?? null, b.unit || null, ...sqlN(n), b.cost_per_serving ?? null);
  const item = foodOut((await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=?", id))!);
  return c.json({ item, needs_lookup: !item.nutrition });
});
mealRoutes.put("/foods/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = foodBody.partial().extend({ archived: z.boolean().optional() }).parse(await c.req.json());
  const next = { amount: b.amount === undefined ? cur.amount : b.amount, unit: b.unit === undefined ? cur.unit : (b.unit || null), servings: 1 };
  let n: StoredNutrition;
  try { n = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings: 1, stored: stored(cur) }, next, editOf(b), compute); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
  await run(c.env.DB, "UPDATE meal_foods SET name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, nutrition_ref=?, cost_per_serving=?, archived_at=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.name ?? cur.name, next.amount, next.unit, ...sqlN(n), b.cost_per_serving === undefined ? cur.cost_per_serving : b.cost_per_serving,
    b.archived === undefined ? (cur.archived_at ?? null) : (b.archived ? new Date().toISOString() : null), id, user.id);
  return c.json({ item: foodOut((await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=?", id))!) });
});
/** Removes it from the list only; past entries keep their copied values. */
mealRoutes.delete("/foods/:id", async (c) => {
  const user = c.get("user");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE meal_entries SET food_id=NULL WHERE food_id=? AND user_id=?").bind(c.req.param("id"), user.id),
    c.env.DB.prepare("DELETE FROM meal_foods WHERE id=? AND user_id=?").bind(c.req.param("id"), user.id),
  ]);
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- sets */
mealRoutes.get("/sets", async (c) => {
  const user = c.get("user");
  await migrateLegacy(c.env, user.id);
  return c.json({ items: await loadSets(c.env, user.id) });
});
/** Create a set; with `entry_ids` its members are copied from those logged entries (「この日の記録をセットにする」). */
mealRoutes.post("/sets", async (c) => {
  const user = c.get("user");
  const b = z.object({ name: z.string().trim().min(1).max(60), entry_ids: z.array(z.string()).max(40).optional() }).parse(await c.req.json());
  const id = newId();
  const order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_sets WHERE user_id=?", user.id))?.n ?? 0;
  const stmts = [c.env.DB.prepare("INSERT INTO meal_sets (id,user_id,name,sort_order) VALUES (?,?,?,?)").bind(id, user.id, b.name, order)];
  if (b.entry_ids?.length) {
    const rows = await all<EntryRow>(c.env.DB, `SELECT * FROM meal_entries WHERE user_id=? AND id IN (${b.entry_ids.map(() => "?").join(",")}) ORDER BY day, sort_order, created_at`, user.id, ...b.entry_ids);
    rows.forEach((e, i) => {
      const ref = refOut(e.nutrition_ref); const k = e.servings || 1;
      stmts.push(c.env.DB.prepare("INSERT INTO meal_routines (id,user_id,slot,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,sort_order,set_id) VALUES (?,?,'other',?,?,?,?,?,?,?,?,?)")
        .bind(newId(), user.id, e.food_name, e.amount == null ? null : Math.round(e.amount * k * 100) / 100, e.unit, e.nutrition_json, e.nutrition_source,
          ref ? JSON.stringify({ ...ref, grams: Math.round(ref.grams * k * 10) / 10 }) : null, e.cost, i, id));
    });
  }
  await c.env.DB.batch(stmts);
  const set = (await loadSets(c.env, user.id)).find((s) => s.id === id)!;
  return c.json({ item: set });
});
mealRoutes.put("/sets/:id", async (c) => {
  const user = c.get("user");
  const b = z.object({ name: z.string().trim().min(1).max(60).optional(), archived: z.boolean().optional() }).parse(await c.req.json());
  const cur = await one<SetRow>(c.env.DB, "SELECT * FROM meal_sets WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE meal_sets SET name=?, archived_at=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
    b.name ?? cur.name, b.archived === undefined ? (cur.archived_at ?? null) : (b.archived ? new Date().toISOString() : null), c.req.param("id"), user.id);
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

/** Add an item to a set (from a saved food, or typed). Typed items without values come back with `needs_lookup`. */
mealRoutes.post("/sets/:id/items", async (c) => {
  const user = c.get("user");
  const setId = c.req.param("id");
  if (!(await one(c.env.DB, "SELECT 1 FROM meal_sets WHERE id=? AND user_id=?", setId, user.id))) return c.json({ error: "not found" }, 404);
  const b = z.object({ food_id: z.string().optional() }).and(foodBody.partial()).parse(await c.req.json());
  let src: { name: string; amount: number | null; unit: string | null; n: StoredNutrition; cost: number | null };
  if (b.food_id) {
    const f = await one<FoodRow>(c.env.DB, "SELECT * FROM meal_foods WHERE id=? AND user_id=?", b.food_id, user.id);
    if (!f) return c.json({ error: "よく食べるものが見つかりません" }, 404);
    src = { name: f.name, amount: f.amount, unit: f.unit, n: stored(f), cost: f.cost_per_serving };
  } else {
    if (!b.name) return c.json({ error: "名前を入力してください" }, 400);
    const amount = b.amount ?? null, unit = b.unit || null;
    src = { name: b.name, amount, unit, n: planNutritionEdit({ amount, unit, servings: 1, stored: EMPTY }, { amount, unit, servings: 1 }, editOf(b), compute), cost: b.cost_per_serving ?? null };
  }
  const order = (await one<{ n: number }>(c.env.DB, "SELECT COALESCE(MAX(sort_order),-1)+1 n FROM meal_routines WHERE set_id=?", setId))?.n ?? 0;
  const id = newId();
  await run(c.env.DB, "INSERT INTO meal_routines (id,user_id,slot,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost_per_serving,sort_order,set_id) VALUES (?,?,'other',?,?,?,?,?,?,?,?,?)",
    id, user.id, src.name, src.amount, src.unit, ...sqlN(src.n), src.cost, order, setId);
  const item = memberOut((await one<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", id))!);
  return c.json({ ok: true, item, needs_lookup: !item.nutrition });
});
mealRoutes.put("/sets/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  const cur = await one<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=? AND set_id=? AND user_id=?", c.req.param("itemId"), c.req.param("id"), user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = foodBody.partial().parse(await c.req.json());
  const next = { amount: b.amount === undefined ? cur.amount : b.amount, unit: b.unit === undefined ? cur.unit : (b.unit || null), servings: 1 };
  let n: StoredNutrition;
  try { n = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings: 1, stored: stored(cur) }, next, editOf(b), compute); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
  await run(c.env.DB, "UPDATE meal_routines SET food_name=?, amount=?, unit=?, nutrition_json=?, nutrition_source=?, nutrition_ref=?, cost_per_serving=?, updated_at=datetime('now') WHERE id=?",
    b.name ?? cur.food_name, next.amount, next.unit, ...sqlN(n), b.cost_per_serving === undefined ? cur.cost_per_serving : b.cost_per_serving, cur.id);
  return c.json({ item: memberOut((await one<MemberRow>(c.env.DB, "SELECT * FROM meal_routines WHERE id=?", cur.id))!) });
});
mealRoutes.delete("/sets/:id/items/:itemId", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM meal_routines WHERE id=? AND set_id=? AND user_id=?", c.req.param("itemId"), c.req.param("id"), user.id);
  return c.json({ ok: true });
});

/* ---------------------------------------------------------------- targets */
/** Daily targets. With all of P/F/C set, energy follows them (4/9/4). */
export const getTargets = (env: Env, userId: string) => getSetting<Nutrition>(env, userId, "nutrition_targets", {});
export async function putTargets(env: Env, userId: string, t: Nutrition) {
  const v = withPfcEnergy(t, true);
  await setSetting(env, userId, "nutrition_targets", v);
  return v;
}

/* ---------------------------------------------------------------- meal chat proposals */
const nutritionLoose = z.record(z.string(), z.number()).nullable().optional();
const logOpZ = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), food_name: z.string().min(1).max(120), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(), cost: z.number().min(0).nullable().optional(), nutrition: nutritionLoose, save_as_food: z.boolean().optional() }),
  z.object({ op: z.literal("update"), id: z.string().min(1), food_name: z.string().optional(), changes: z.object({ food_name: z.string().min(1).max(120).optional(), amount: z.number().positive().nullable().optional(), unit: z.string().max(20).nullable().optional(), cost: z.number().min(0).nullable().optional(), nutrition: nutritionLoose }) }),
  z.object({ op: z.literal("remove"), id: z.string().min(1), food_name: z.string().optional() }),
]);
/**
 * Apply what the user ticked on a chat proposal card. Instant: added items keep the AI's numbers as
 * 推定 (or none), and their ids come back in `pending_ids` so the client fills them from the 成分表
 * afterwards (a 成分表 match replaces an AI guess).
 */
mealRoutes.post("/apply-proposal", async (c) => {
  const user = c.get("user");
  const b = z.object({ message_id: z.string().optional(), day: dayZ.optional(), entries: z.array(logOpZ).max(12).default([]), targets: nutritionLoose }).parse(await c.req.json());
  const day = b.day ?? jstDate();
  const existing = await all<EntryRow>(c.env.DB, "SELECT * FROM meal_entries WHERE user_id=? AND day=?", user.id, day);
  const norm = normalizeMealProposal({ entries: b.entries, targets: b.targets ?? null }, existing.map((m) => ({ id: m.id, food_name: m.food_name, amount: m.amount, nutrition: parseNutrition(m.nutrition_json) })));
  const stmts: D1PreparedStatement[] = [];
  const done = { added: 0, updated: 0, removed: 0, targets: false, skipped: b.entries.length - norm.entries.length };
  const pending: string[] = [];
  let order = await nextOrder(c.env, user.id, day);
  for (const op of norm.entries) {
    if (op.op === "add") {
      const n = planNutritionEdit({ amount: op.amount, unit: op.unit, servings: 1, stored: EMPTY }, { amount: op.amount, unit: op.unit, servings: 1 }, { nutrition: op.nutrition, source: "estimated" }, compute);
      const foodId = op.save_as_food ? await upsertFood(c.env, user.id, { name: op.food_name, amount: op.amount, unit: op.unit, per: n, cost: op.cost }) : null;
      const id = newId(); pending.push(id);
      stmts.push(c.env.DB.prepare("INSERT INTO meal_entries (id,user_id,day,food_name,amount,unit,nutrition_json,nutrition_source,nutrition_ref,cost,servings,food_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)")
        .bind(id, user.id, day, op.food_name, op.amount, op.unit, ...sqlN(n), op.cost, foodId, order++));
      done.added++;
    } else if (op.op === "update") {
      const cur = existing.find((m) => m.id === op.id)!; const ch = op.changes;
      const next = { amount: ch.amount === undefined ? cur.amount : ch.amount, unit: ch.unit ?? cur.unit, servings: cur.servings };
      const n = planNutritionEdit({ amount: cur.amount, unit: cur.unit, servings: cur.servings, stored: stored(cur) }, next,
        ch.nutrition ? { nutrition: ch.nutrition, source: "estimated" } : {}, compute);
      stmts.push(c.env.DB.prepare("UPDATE meal_entries SET food_name=?,amount=?,unit=?,nutrition_json=?,nutrition_source=?,nutrition_ref=?,cost=?,updated_at=datetime('now') WHERE id=? AND user_id=?")
        .bind(ch.food_name ?? cur.food_name, next.amount, next.unit, ...sqlN(n), ch.cost === undefined ? cur.cost : ch.cost, op.id, user.id));
      done.updated++;
    } else {
      stmts.push(c.env.DB.prepare("DELETE FROM meal_entries WHERE id=? AND user_id=?").bind(op.id, user.id));
      done.removed++;
    }
  }
  if (norm.targets) {
    const cur = await getTargets(c.env, user.id);
    const merged = { ...cur, ...norm.targets };
    stmts.push(c.env.DB.prepare("INSERT INTO settings (user_id,key,value_json,updated_at) VALUES (?,'nutrition_targets',?,datetime('now')) ON CONFLICT(user_id,key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now')")
      .bind(user.id, JSON.stringify(["protein_g", "fat_g", "carbs_g"].some((k) => k in norm.targets!) ? withPfcEnergy(merged, true) : merged)));
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
  return c.json({ ok: true, ...done, pending_ids: pending, ...(await dayLog(c.env, user.id, day)) });
});

/** Context for the meal chat: today's log, its totals, the targets and saved foods. */
export async function mealChatContext(env: Env, userId: string) {
  const [log, foods] = await Promise.all([
    dayLog(env, userId, jstDate()),
    all<{ name: string; amount: number | null; unit: string | null }>(env.DB, "SELECT name,amount,unit FROM meal_foods WHERE user_id=? AND archived_at IS NULL ORDER BY use_count DESC LIMIT 30", userId),
  ]);
  return { log, foods };
}
