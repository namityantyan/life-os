import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId } from "../../core/db";
import { chatJson } from "../../core/ai";
import { IDEA_STATUSES, buildIdeaMarkdown, ensureFrontMatter, exportIdeasMarkdown, firstLineTitle, syncFrontMatter } from "./logic";

export const routes = new Hono<AppEnv>();

type IdeaRow = { id: string; raw_text: string; title: string | null; markdown: string | null; status: string; organized_at: string | null; archived_at: string | null; created_at: string; updated_at: string };
const COLS = "id,raw_text,title,markdown,status,organized_at,archived_at,created_at,updated_at";
const getIdea = (db: D1Database, id: string, userId: string) => one<IdeaRow>(db, `SELECT ${COLS} FROM ideas WHERE id=? AND user_id=?`, id, userId);

routes.get("/", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status");
  const archived = c.req.query("archived") === "1";
  const where = [`user_id=?`, archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const params: unknown[] = [user.id];
  if (status && (IDEA_STATUSES as readonly string[]).includes(status)) { where.push("status=?"); params.push(status); }
  const items = await all<IdeaRow>(c.env.DB, `SELECT ${COLS} FROM ideas WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 500`, ...params);
  return c.json({ items });
});

routes.post("/", async (c) => {
  const user = c.get("user");
  const body = z.object({ raw_text: z.string().trim().min(1).max(20000) }).parse(await c.req.json());
  const id = newId();
  await run(c.env.DB, "INSERT INTO ideas (id,user_id,raw_text,status) VALUES (?,?,?,'inbox')", id, user.id, body.raw_text);
  return c.json({ item: await getIdea(c.env.DB, id, user.id) }, 201);
});

// Bulk export for Obsidian: all non-archived ideas as one markdown document.
routes.get("/export", async (c) => {
  const user = c.get("user");
  const items = await all<IdeaRow>(c.env.DB, `SELECT ${COLS} FROM ideas WHERE user_id=? AND archived_at IS NULL ORDER BY created_at`, user.id);
  const md = exportIdeasMarkdown(items);
  return c.body(md, 200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="ideas-export.md"` });
});

routes.get("/:id", async (c) => {
  const item = await getIdea(c.env.DB, c.req.param("id"), c.get("user").id);
  return item ? c.json({ item }) : c.json({ error: "not found" }, 404);
});

routes.post("/:id/organize", async (c) => {
  const user = c.get("user");
  const item = await getIdea(c.env.DB, c.req.param("id"), user.id);
  if (!item) return c.json({ error: "not found" }, 404);
  const fallbackTitle = item.title || firstLineTitle(item.raw_text);
  const fallback = { title: fallbackTitle, markdown: "", tags: [] as string[] };
  const { data, provider } = await chatJson<{ title?: string; markdown?: string; tags?: string[] }>(c.env, [
    { role: "system", content: "あなたはメモ整理のアシスタントです。ユーザーの書き殴りのアイデアを、Obsidianで読みやすいMarkdownノートに整理します。内容を勝手に増やさず、原文の意図を保ちながら見出し・箇条書きで構造化してください。出力はJSONのみ: {\"title\": 短い日本語タイトル(30字以内), \"tags\": [英小文字または日本語のタグ最大5個], \"markdown\": 本文のMarkdown(front matterやH1タイトルは含めない)}" },
    { role: "user", content: item.raw_text },
  ], fallback);
  const title = (typeof data.title === "string" && data.title.trim()) ? data.title.trim().slice(0, 80) : fallbackTitle;
  const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string").slice(0, 5) : [];
  const meta = { title, created: item.created_at, status: item.status, tags };
  const bodyMd = provider === "fallback" || typeof data.markdown !== "string" || !data.markdown.trim() ? item.raw_text : data.markdown;
  const markdown = provider === "fallback" ? buildIdeaMarkdown(meta, bodyMd) : ensureFrontMatter(bodyMd.replace(/^#\s[^\n]*\n+/, ""), meta);
  await run(c.env.DB, "UPDATE ideas SET title=?, markdown=?, organized_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND user_id=?", title, markdown, item.id, user.id);
  return c.json({ item: await getIdea(c.env.DB, item.id, user.id), provider });
});

routes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = z.object({
    title: z.string().trim().max(200).nullable().optional(),
    markdown: z.string().max(100000).nullable().optional(),
    status: z.enum(IDEA_STATUSES).optional(),
    archived: z.boolean().optional(),
  }).parse(await c.req.json());
  const existing = await getIdea(c.env.DB, id, user.id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const sets: string[] = ["updated_at=datetime('now')"]; const params: unknown[] = [];
  const title = body.title !== undefined ? (body.title || null) : existing.title;
  const status = body.status ?? existing.status;
  let markdown = body.markdown !== undefined ? (body.markdown || null) : existing.markdown;
  // Keep the exported note's front matter honest: title/status edits are reflected in the stored markdown.
  if (markdown && (title !== existing.title || status !== existing.status || body.markdown !== undefined)) {
    markdown = syncFrontMatter(markdown, { title: title || firstLineTitle(existing.raw_text), created: existing.created_at, status });
  }
  if (body.title !== undefined) { sets.push("title=?"); params.push(title); }
  if (markdown !== existing.markdown) { sets.push("markdown=?"); params.push(markdown); }
  if (body.status !== undefined) { sets.push("status=?"); params.push(status); }
  if (body.archived !== undefined) sets.push(body.archived ? "archived_at=COALESCE(archived_at, datetime('now'))" : "archived_at=NULL");
  await run(c.env.DB, `UPDATE ideas SET ${sets.join(", ")} WHERE id=? AND user_id=?`, ...params, id, user.id);
  return c.json({ item: await getIdea(c.env.DB, id, user.id) });
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "UPDATE ideas SET archived_at=COALESCE(archived_at, datetime('now')), updated_at=datetime('now') WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});
