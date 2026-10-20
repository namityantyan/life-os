import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId, nowIso, jstDate } from "../../core/db";
import { addDays, applyPatch, normalizeFields, splitItems, PLANNER_TYPES, type PlannerItem } from "./logic";
import { fetchGoogleEvents } from "./google";

export const routes = new Hono<AppEnv>();

const COLS = "id,type,title,notes,date,start_at,end_at,remind_at,reminded_at,done_at,archived_at,created_at,updated_at";
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ISO datetime");

const rangeSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
function range(q: Record<string, string | undefined>) {
  const r = rangeSchema.parse(q);
  const from = r.from ?? jstDate();
  const to = r.to ?? addDays(from, 7);
  return { from, to };
}

const createSchema = z.object({
  type: z.enum(PLANNER_TYPES),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000).nullish(),
  date: isoDate.nullish(),
  start_at: isoDateTime.nullish(),
  end_at: isoDateTime.nullish(),
  remind_at: isoDateTime.nullish(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().max(4000).nullable().optional(),
  date: isoDate.nullable().optional(),
  start_at: isoDateTime.nullable().optional(),
  end_at: isoDateTime.nullable().optional(),
  remind_at: isoDateTime.nullable().optional(),
  done: z.boolean().optional(),
  unschedule: z.boolean().optional(),
});

async function getItem(c: { env: AppEnv["Bindings"] }, userId: string, id: string) {
  return one<PlannerItem>(c.env.DB, `SELECT ${COLS} FROM planner_items WHERE id=? AND user_id=? AND archived_at IS NULL`, id, userId);
}

// GET /?from=YYYY-MM-DD&to=YYYY-MM-DD → { items (in range), undated, done, from, to }
routes.get("/", async (c) => {
  const user = c.get("user");
  const { from, to } = range(c.req.query());
  const rows = await all<PlannerItem>(c.env.DB, `SELECT ${COLS} FROM planner_items WHERE user_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 2000`, user.id);
  return c.json({ from, to, ...splitItems(rows, from, to) });
});

// GET /google?from&to → read-only Google Calendar events (kept separate so local items never wait for Google)
routes.get("/google", async (c) => {
  const user = c.get("user");
  const { from, to } = range(c.req.query());
  try {
    return c.json(await fetchGoogleEvents(c.env, user.id, from, to));
  } catch (e) {
    return c.json({ connected: true, items: [], error: String(e) });
  }
});

routes.post("/", async (c) => {
  const user = c.get("user");
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid", detail: parsed.error.issues }, 400);
  const b = parsed.data;
  const f = normalizeFields(b.type, { date: b.date ?? null, start_at: b.start_at ?? null, end_at: b.end_at ?? null, remind_at: b.remind_at ?? null });
  const id = newId();
  const now = nowIso();
  await run(c.env.DB,
    "INSERT INTO planner_items (id,user_id,type,title,notes,date,start_at,end_at,remind_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    id, user.id, b.type, b.title, b.notes?.trim() || null, f.date, f.start_at, f.end_at, f.remind_at, now, now);
  const item = await getItem(c, user.id, id);
  return c.json({ item }, 201);
});

routes.patch("/:id", async (c) => {
  const user = c.get("user");
  const item = await getItem(c, user.id, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid", detail: parsed.error.issues }, 400);
  const next = applyPatch(item, parsed.data, nowIso());
  await run(c.env.DB,
    "UPDATE planner_items SET title=?, notes=?, date=?, start_at=?, end_at=?, remind_at=?, reminded_at=?, done_at=?, updated_at=? WHERE id=? AND user_id=?",
    next.title, next.notes, next.date, next.start_at, next.end_at, next.remind_at, next.reminded_at, next.done_at, next.updated_at, item.id, user.id);
  return c.json({ item: await getItem(c, user.id, item.id) });
});

// Soft delete: keep an internal archive, no user-facing trash.
routes.delete("/:id", async (c) => {
  const user = c.get("user");
  const item = await getItem(c, user.id, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE planner_items SET archived_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND user_id=?", item.id, user.id);
  return c.json({ ok: true });
});
