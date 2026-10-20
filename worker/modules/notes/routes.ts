import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId } from "../../core/db";
import { likePattern } from "./logic";

export const routes = new Hono<AppEnv>();

export const NOTE_CATEGORIES = ["policy", "decision", "promise", "preference", "other"] as const;
type NoteRow = { id: string; category: string; content: string; archived_at: string | null; created_at: string; updated_at: string };
const COLS = "id,category,content,archived_at,created_at,updated_at";
const getNote = (db: D1Database, id: string, userId: string) => one<NoteRow>(db, `SELECT ${COLS} FROM notes WHERE id=? AND user_id=?`, id, userId);

routes.get("/", async (c) => {
  const user = c.get("user");
  const category = c.req.query("category");
  const q = (c.req.query("q") ?? "").trim();
  const archived = c.req.query("archived") === "1";
  const where = ["user_id=?", archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const params: unknown[] = [user.id];
  if (category && (NOTE_CATEGORIES as readonly string[]).includes(category)) { where.push("category=?"); params.push(category); }
  if (q) { where.push("content LIKE ? ESCAPE '\\'"); params.push(likePattern(q)); }
  const items = await all<NoteRow>(c.env.DB, `SELECT ${COLS} FROM notes WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 500`, ...params);
  return c.json({ items });
});

routes.post("/", async (c) => {
  const user = c.get("user");
  const body = z.object({ category: z.enum(NOTE_CATEGORIES).default("other"), content: z.string().trim().min(1).max(5000) }).parse(await c.req.json());
  const id = newId();
  await run(c.env.DB, "INSERT INTO notes (id,user_id,category,content) VALUES (?,?,?,?)", id, user.id, body.category, body.content);
  return c.json({ item: await getNote(c.env.DB, id, user.id) }, 201);
});

routes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = z.object({ category: z.enum(NOTE_CATEGORIES).optional(), content: z.string().trim().min(1).max(5000).optional(), archived: z.boolean().optional() }).parse(await c.req.json());
  if (!(await getNote(c.env.DB, id, user.id))) return c.json({ error: "not found" }, 404);
  const sets = ["updated_at=datetime('now')"]; const params: unknown[] = [];
  if (body.category !== undefined) { sets.push("category=?"); params.push(body.category); }
  if (body.content !== undefined) { sets.push("content=?"); params.push(body.content); }
  if (body.archived !== undefined) sets.push(body.archived ? "archived_at=COALESCE(archived_at, datetime('now'))" : "archived_at=NULL");
  await run(c.env.DB, `UPDATE notes SET ${sets.join(", ")} WHERE id=? AND user_id=?`, ...params, id, user.id);
  return c.json({ item: await getNote(c.env.DB, id, user.id) });
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "UPDATE notes SET archived_at=COALESCE(archived_at, datetime('now')), updated_at=datetime('now') WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});
