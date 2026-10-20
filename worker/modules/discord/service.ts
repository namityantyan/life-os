import type { Env } from "../../env";
import { all, one, run, newId } from "../../core/db";
import { adviseWithContext } from "../../core/context";
import { COMMAND_DEFINITIONS, isTrainingPhrase, moduleUrl, resolveDashboardLink, truncateForDiscord } from "./logic";

export const CHANNEL = "discord";
const HISTORY_TURNS = 20;
export const LINK_CODE_TTL_SEC = 600;
export const linkKey = (code: string) => `discord:link:${code}`;

export type BotReply = { reply: string; provider?: "workers-ai" | "fallback" | "rule" | "training"; action: "dashboard" | "training" | "chat" };

/* ---------- Training NLP bridge ----------
 * `logFromText` is provided by the training module (currently exported from training/routes.ts,
 * nlp.ts is the planned home). `import.meta.glob` resolves to {} for files that do not exist, so this
 * module compiles and runs either way; when present, the training parser gets first pick. */
type LogFromText = (env: Env, userId: string, text: string) => Promise<unknown>;
const trainingModules = import.meta.glob<{ logFromText?: LogFromText }>(["../training/nlp.ts", "../training/routes.ts"]);

async function tryTrainingLog(env: Env, userId: string, text: string): Promise<string | null> {
  try {
    for (const key of ["../training/nlp.ts", "../training/routes.ts"]) {
      const loader = trainingModules[key];
      if (!loader) continue;
      const mod = await loader();
      if (typeof mod.logFromText !== "function") continue;
      const r = await mod.logFromText(env, userId, text);
      if (r == null || r === false) return null;
      if (typeof r === "string") return r || null;
      if (typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      // training LogResult: { action: "set"|"start"|"finish"|"advice"|"unknown", ok, message }
      if (o.action === "unknown" || o.handled === false || o.matched === false) return null;
      const msg = [o.reply, o.message, o.text, o.summary].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      if (msg) return msg;
      return o.ok === false ? null : "トレーニングを記録しました。";
    }
    return null;
  } catch (e) {
    console.warn("discord: training logFromText failed", e);
    return null;
  }
}

/* ---------- Conversation ---------- */
async function saveMessage(env: Env, userId: string, role: "user" | "assistant", content: string, meta?: Record<string, unknown>) {
  await run(env.DB, "INSERT INTO chat_messages (id,user_id,channel,role,content,meta_json) VALUES (?,?,?,?,?,?)", newId(), userId, CHANNEL, role, content, meta ? JSON.stringify(meta) : null);
}

/**
 * The single message handler shared by `/chat`, the settings-page preview and e2e (`POST /simulate`).
 * Order: screen-link request → training log (if nlp module present) → AI conversation with Life Context.
 */
export async function handleMessage(env: Env, userId: string, rawText: string): Promise<BotReply> {
  const text = rawText.trim();
  if (!text) return { reply: "内容が空です。話しかける内容を入力してください。", provider: "rule", action: "chat" };
  await saveMessage(env, userId, "user", text);

  const path = resolveDashboardLink(text);
  if (path) {
    const reply = `こちらです: ${moduleUrl(env.APP_ORIGIN, path)}`;
    await saveMessage(env, userId, "assistant", reply, { action: "dashboard", path });
    return { reply, provider: "rule", action: "dashboard" };
  }

  if (isTrainingPhrase(text)) {
    const logged = await tryTrainingLog(env, userId, text);
    if (logged) {
      await saveMessage(env, userId, "assistant", logged, { action: "training" });
      return { reply: logged, provider: "training", action: "training" };
    }
  }

  const rows = await all<{ role: "user" | "assistant"; content: string }>(env.DB,
    "SELECT role,content FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT ?", userId, CHANNEL, HISTORY_TURNS * 2);
  const history = rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  if (history.length === 0 || history[history.length - 1].content !== text) history.push({ role: "user", content: text });
  const r = await adviseWithContext(env, userId, "生活管理BOT（Discord）。睡眠・トレーニング・予定・お金・メモを踏まえて、短く実用的に答える", history);
  const reply = truncateForDiscord(r.text);
  await saveMessage(env, userId, "assistant", reply, { provider: r.provider });
  return { reply, provider: r.provider, action: "chat" };
}

export async function resetHistory(env: Env, userId: string) {
  await run(env.DB, "DELETE FROM chat_messages WHERE user_id=? AND channel=?", userId, CHANNEL);
}
export async function getHistory(env: Env, userId: string, limit = 50) {
  const rows = await all<{ id: string; role: string; content: string; meta_json: string | null; created_at: string }>(env.DB,
    "SELECT id,role,content,meta_json,created_at FROM chat_messages WHERE user_id=? AND channel=? ORDER BY created_at DESC, rowid DESC LIMIT ?", userId, CHANNEL, limit);
  return rows.reverse().map((r) => ({ id: r.id, role: r.role, content: r.content, created_at: r.created_at, meta: r.meta_json ? safeJson(r.meta_json) : null }));
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------- Links / channels ---------- */
export type LinkRow = { discord_user_id: string; user_id: string; created_at: string };
export const findLinkByDiscordUser = (env: Env, discordUserId: string) => one<LinkRow>(env.DB, "SELECT * FROM discord_links WHERE discord_user_id=?", discordUserId);
export const findLinkByUser = (env: Env, userId: string) => one<LinkRow>(env.DB, "SELECT * FROM discord_links WHERE user_id=? ORDER BY created_at DESC LIMIT 1", userId);

export async function createLinkCode(env: Env, userId: string, code: string) {
  await env.KV.put(linkKey(code), userId, { expirationTtl: LINK_CODE_TTL_SEC });
  return { code, expires_at: new Date(Date.now() + LINK_CODE_TTL_SEC * 1000).toISOString() };
}

/** Consume a one-time link code; returns the linked Life OS user id or null. One Discord account per user. */
export async function consumeLinkCode(env: Env, code: string, discordUserId: string): Promise<string | null> {
  const userId = await env.KV.get(linkKey(code));
  if (!userId) return null;
  await env.KV.delete(linkKey(code));
  await run(env.DB, "DELETE FROM discord_links WHERE user_id=? OR discord_user_id=?", userId, discordUserId);
  await run(env.DB, "INSERT INTO discord_links (discord_user_id,user_id) VALUES (?,?)", discordUserId, userId);
  return userId;
}
export async function unlink(env: Env, userId: string) {
  await run(env.DB, "DELETE FROM discord_links WHERE user_id=?", userId);
}

export type ChannelRow = { guild_id: string; channel_id: string; user_id: string; updated_at: string };
export const listChannels = (env: Env, userId: string) => all<ChannelRow>(env.DB, "SELECT * FROM discord_channels WHERE user_id=? ORDER BY updated_at DESC", userId);
export const getChannel = (env: Env, guildId: string) => one<ChannelRow>(env.DB, "SELECT * FROM discord_channels WHERE guild_id=?", guildId);
export async function setChannel(env: Env, guildId: string, channelId: string, userId: string) {
  await run(env.DB, "INSERT INTO discord_channels (guild_id,channel_id,user_id,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, user_id=excluded.user_id, updated_at=datetime('now')", guildId, channelId, userId);
}
export async function clearChannel(env: Env, guildId: string) {
  await run(env.DB, "DELETE FROM discord_channels WHERE guild_id=?", guildId);
}

/* ---------- Discord REST ---------- */
export function discordConfig(env: Env) {
  return { publicKey: Boolean(env.DISCORD_PUBLIC_KEY), applicationId: Boolean(env.DISCORD_APPLICATION_ID), botToken: Boolean(env.DISCORD_BOT_TOKEN) };
}

/** Bulk-overwrite the global slash commands. Needs DISCORD_APPLICATION_ID + DISCORD_BOT_TOKEN. */
export async function registerCommands(env: Env): Promise<{ ok: boolean; count: number; status?: number; error?: string }> {
  if (!env.DISCORD_APPLICATION_ID || !env.DISCORD_BOT_TOKEN) return { ok: false, count: 0, error: "DISCORD_APPLICATION_ID / DISCORD_BOT_TOKEN が未設定です" };
  const res = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  });
  if (!res.ok) return { ok: false, count: 0, status: res.status, error: (await res.text()).slice(0, 300) };
  const data = (await res.json()) as unknown[];
  return { ok: true, count: Array.isArray(data) ? data.length : COMMAND_DEFINITIONS.length, status: res.status };
}

/** Finish a deferred interaction by editing the original response through the interaction webhook. */
export async function editOriginalResponse(applicationId: string, token: string, content: string): Promise<boolean> {
  const res = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: truncateForDiscord(content) }),
  });
  if (!res.ok) console.warn("discord: edit original failed", res.status, await res.text().catch(() => ""));
  return res.ok;
}
