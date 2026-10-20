import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, run, one, newId, nowIso, jstDate } from "../../core/db";
import { chatJson } from "../../core/ai";
import { adviseWithContext, buildLifeContext } from "../../core/context";
import { buildBriefing, normalizeAction, normalizeActions, actionToRow, type AssistantAction } from "./logic";

export const routes = new Hono<AppEnv>();

const CHANNEL = "general";
const ROLE = "総合的な生活アシスタント。睡眠・トレーニング・予定・お金・メモの全体を見て、今日どう動くかを短く提案する。診断・投資・送金は実行しない。";

type ChatRow = { id: string; role: "user" | "assistant"; content: string; meta_json: string | null; created_at: string };
const chatOut = (m: ChatRow) => {
  let meta: any = null; try { meta = m.meta_json ? JSON.parse(m.meta_json) : null; } catch { /* ignore */ }
  return { id: m.id, role: m.role, content: m.content, created_at: m.created_at, provider: meta?.provider, actions: normalizeActions(meta?.actions) };
};

routes.get("/briefing", async (c) => {
  const user = c.get("user");
  const ctx = await buildLifeContext(c.env, user.id, { weather: true });
  return c.json({ today: jstDate(), briefing: buildBriefing(ctx) });
});

routes.get("/history", async (c) => {
  const rows = await all<ChatRow>(c.env.DB, "SELECT id,role,content,meta_json,created_at FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT 50", c.get("user").id, CHANNEL);
  return c.json({ items: rows.reverse().map(chatOut) });
});

routes.delete("/history", async (c) => {
  await run(c.env.DB, "DELETE FROM chat_messages WHERE user_id=? AND channel=?", c.get("user").id, CHANNEL);
  return c.json({ ok: true });
});

routes.post("/chat", async (c) => {
  const user = c.get("user");
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(await c.req.json());
  const prior = (await all<ChatRow>(c.env.DB, "SELECT id,role,content,meta_json,created_at FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT 20", user.id, CHANNEL)).reverse();
  const userId = newId();
  await run(c.env.DB, "INSERT INTO chat_messages (id,user_id,channel,role,content) VALUES (?,?,?,?,?)", userId, user.id, CHANNEL, "user", text);
  const history = [...prior.map((m) => ({ role: m.role, content: m.content })), { role: "user" as const, content: text }];
  const reply = await adviseWithContext(c.env, user.id, ROLE, history);

  // Structured follow-ups: only when the AI is really reachable (the fallback must never invent actions).
  let actions: AssistantAction[] = [];
  if (reply.provider === "workers-ai") {
    const r = await chatJson<{ actions?: unknown }>(c.env, [
      { role: "system", content: `利用者の発言とアシスタントの返答から、利用者がワンタップで登録できそうなフォローアップを最大3件、JSONのみで返します。形式: {"actions":[{"type":"task"|"reminder"|"note","title":"短い日本語","when":"YYYY-MM-DD または ISO日時（任意）"}]}。該当がなければ {"actions":[]}。今日は ${jstDate()}。` },
      { role: "user", content: `発言: ${text}\n返答: ${reply.text}` },
    ], { actions: [] });
    if (r.provider === "workers-ai") actions = normalizeActions(r.data);
  }
  const assistantId = newId();
  await run(c.env.DB, "INSERT INTO chat_messages (id,user_id,channel,role,content,meta_json) VALUES (?,?,?,?,?,?)", assistantId, user.id, CHANNEL, "assistant", reply.text, JSON.stringify({ provider: reply.provider, actions }));
  return c.json({
    user: { id: userId, role: "user", content: text, actions: [] },
    assistant: { id: assistantId, role: "assistant", content: reply.text, provider: reply.provider, actions },
  });
});

routes.post("/apply", async (c) => {
  const user = c.get("user");
  const body = z.object({ action: z.object({ type: z.enum(["task", "reminder", "note"]), title: z.string(), when: z.string().nullish() }) }).safeParse(await c.req.json());
  if (!body.success) return c.json({ error: "invalid", detail: body.error.issues }, 400);
  const a = normalizeAction(body.data.action);
  if (!a) return c.json({ error: "invalid action" }, 400);
  const row = actionToRow(a, jstDate());
  const id = newId();
  let item: unknown = null;
  if (row.table === "notes") {
    await run(c.env.DB, "INSERT INTO notes (id,user_id,category,content) VALUES (?,?,?,?)", id, user.id, row.category, row.content);
    item = await one(c.env.DB, "SELECT id,category,content,created_at FROM notes WHERE id=?", id);
  } else {
    const now = nowIso();
    await run(c.env.DB,
      "INSERT INTO planner_items (id,user_id,type,title,notes,date,start_at,end_at,remind_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, user.id, row.type, row.title, null, row.date, null, null, row.remind_at, now, now);
    item = await one(c.env.DB, "SELECT id,type,title,date,remind_at FROM planner_items WHERE id=?", id);
  }
  return c.json({ ok: true, type: a.type, item }, 201);
});
