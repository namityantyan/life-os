import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId } from "../../core/db";

export const routes = new Hono<AppEnv>();

export const REQUEST_STATUSES = ["open", "in_progress", "done"] as const;
type RequestRow = { id: string; title: string; detail: string | null; example: string | null; status: string; created_at: string; updated_at: string };
const COLS = "id,title,detail,example,status,created_at,updated_at";
const getReq = (db: D1Database, id: string, userId: string) => one<RequestRow>(db, `SELECT ${COLS} FROM requests WHERE id=? AND user_id=?`, id, userId);

routes.get("/", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status");
  const q = (c.req.query("q") ?? "").trim();
  const where = ["user_id=?"]; const params: unknown[] = [user.id];
  if (status && (REQUEST_STATUSES as readonly string[]).includes(status)) { where.push("status=?"); params.push(status); }
  if (q) { where.push("(title LIKE ? OR detail LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  const items = await all<RequestRow>(c.env.DB, `SELECT ${COLS} FROM requests WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, updated_at DESC LIMIT 500`, ...params);
  return c.json({ items });
});

const bodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(10000).nullable().optional(),
  example: z.string().trim().max(10000).nullable().optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
});

routes.post("/", async (c) => {
  const user = c.get("user");
  const body = bodySchema.parse(await c.req.json());
  const id = newId();
  await run(c.env.DB, "INSERT INTO requests (id,user_id,title,detail,example,status) VALUES (?,?,?,?,?,?)", id, user.id, body.title, body.detail || null, body.example || null, body.status ?? "open");
  return c.json({ item: await getReq(c.env.DB, id, user.id) }, 201);
});

routes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = bodySchema.partial().parse(await c.req.json());
  if (!(await getReq(c.env.DB, id, user.id))) return c.json({ error: "not found" }, 404);
  const sets = ["updated_at=datetime('now')"]; const params: unknown[] = [];
  if (body.title !== undefined) { sets.push("title=?"); params.push(body.title); }
  if (body.detail !== undefined) { sets.push("detail=?"); params.push(body.detail || null); }
  if (body.example !== undefined) { sets.push("example=?"); params.push(body.example || null); }
  if (body.status !== undefined) { sets.push("status=?"); params.push(body.status); }
  await run(c.env.DB, `UPDATE requests SET ${sets.join(", ")} WHERE id=? AND user_id=?`, ...params, id, user.id);
  return c.json({ item: await getReq(c.env.DB, id, user.id) });
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM requests WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});
