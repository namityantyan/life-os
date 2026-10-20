import { Hono } from "hono";
import { z } from "zod";
import { verifyKey } from "discord-interactions";
import type { AppEnv, Env } from "../../env";
import {
  COMMAND_DEFINITIONS, EPHEMERAL, InteractionResponseType, generateLinkCode, helpMessage, isFromBot, moduleUrl,
  normalizeLinkCode, notLinkedMessage, parseInteraction, resolveModule, truncateForDiscord,
} from "./logic";
import {
  clearChannel, consumeLinkCode, createLinkCode, discordConfig, editOriginalResponse, findLinkByDiscordUser, findLinkByUser,
  getChannel, getHistory, handleMessage, listChannels, registerCommands, resetHistory, setChannel, unlink,
} from "./service";

export { registerCommands };

/* =====================================================================================
 * Public: Discord Interactions endpoint  (POST /api/integrations/discord/interactions)
 * Cloudflare Workers cannot hold a gateway websocket, so the bot only receives slash
 * commands (and PINGs) over HTTP. Every request is verified with the app's Ed25519 key.
 * ===================================================================================== */
export const publicRoutes = new Hono<AppEnv>();

const msg = (content: string, ephemeral = true) => ({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: truncateForDiscord(content), ...(ephemeral ? { flags: EPHEMERAL } : {}) } });

publicRoutes.post("/interactions", async (c) => {
  const signature = c.req.header("X-Signature-Ed25519");
  const timestamp = c.req.header("X-Signature-Timestamp");
  const body = await c.req.text();
  if (!signature || !timestamp || !c.env.DISCORD_PUBLIC_KEY) return c.json({ error: "invalid request signature" }, 401);
  let valid = false;
  try { valid = await verifyKey(body, signature, timestamp, c.env.DISCORD_PUBLIC_KEY); } catch { valid = false; }
  if (!valid) return c.json({ error: "invalid request signature" }, 401);

  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return c.json({ error: "bad json" }, 400); }
  const it = parseInteraction(payload);
  if (it.kind === "ping") return c.json({ type: InteractionResponseType.PONG });
  if (it.kind !== "command") return c.json(msg("このやり取りには対応していません。"));
  // Never react to bot / webhook authored interactions (no chained conversations).
  if (isFromBot(it.user, (payload as { message?: { webhook_id?: string } })?.message?.webhook_id)) return c.json(msg("BOTやWebhookからの発言には反応しません。"));
  if (!it.user) return c.json(msg("ユーザー情報を取得できませんでした。"));

  const env = c.env;
  const origin = env.APP_ORIGIN;
  const discordUserId = it.user.id;

  // /link works before pairing; everything else requires a registered owner.
  if (it.name === "link") {
    const code = normalizeLinkCode(it.options.code ?? "");
    if (code.length !== 6) return c.json(msg("連携コードは6文字です。設定画面で発行したコードを入力してください。"));
    const userId = await consumeLinkCode(env, code, discordUserId);
    if (!userId) return c.json(msg("連携コードが無効か期限切れです。設定画面でコードを再発行してください（10分間有効）。"));
    return c.json(msg("Life OSと連携しました。/chat で会話、/dash で画面リンクを取得できます。"));
  }

  const link = await findLinkByDiscordUser(env, discordUserId);
  if (!link) return c.json(msg(notLinkedMessage(origin)));
  const userId = link.user_id;

  switch (it.name) {
    case "dashboard":
    case "dash": {
      const mod = resolveModule(it.options.module ?? "");
      if (!mod) return c.json(msg(`画面が見つかりません: ${it.options.module}\n指定できる画面: ${COMMAND_MODULE_HINT}`));
      return c.json(msg(`${mod.label}: ${moduleUrl(origin, mod.path)}`, false));
    }
    case "chathere": {
      if (!it.guildId || !it.channelId) return c.json(msg("サーバーのテキストチャンネル内で実行してください。"));
      await setChannel(env, it.guildId, it.channelId, userId);
      return c.json(msg(`このチャンネル（<#${it.channelId}>）を会話用チャンネルに設定しました。\n注意: 現在の構成（Discord Interactions）では通常発言には反応できないため、会話は /chat を使ってください。`, false));
    }
    case "chatstatus": {
      if (!it.guildId) return c.json(msg("DMでは会話用チャンネルの設定はありません。/chat で会話できます。"));
      const ch = await getChannel(env, it.guildId);
      return c.json(msg(ch ? `会話用チャンネル: <#${ch.channel_id}>（設定: ${ch.updated_at}）` : "このサーバーには会話用チャンネルが設定されていません。/chathere で設定できます。"));
    }
    case "chatoff": {
      if (!it.guildId) return c.json(msg("DMでは会話用チャンネルの設定はありません。"));
      const ch = await getChannel(env, it.guildId);
      if (ch && ch.user_id !== userId) return c.json(msg("この設定は登録した所有者のみ解除できます。"));
      await clearChannel(env, it.guildId);
      return c.json(msg("会話用チャンネルの設定を解除しました（会話履歴は保持されます。履歴の消去は /reset）。"));
    }
    case "reset": {
      await resetHistory(env, userId);
      return c.json(msg("BOTとの会話履歴をリセットしました（チャンネル設定はそのままです）。"));
    }
    case "chat": {
      const text = (it.options.text ?? "").trim();
      if (!text) return c.json(msg(helpMessage()));
      if (!it.token || !it.applicationId) return c.json(msg("応答先を特定できませんでした。"));
      // AI may exceed Discord's 3-second limit → defer, then edit the original message via the webhook.
      const work = (async () => {
        let reply: string;
        try { reply = (await handleMessage(env, userId, text)).reply; }
        catch (e) { console.error("discord chat failed", e); reply = "処理中にエラーが発生しました。しばらくしてからもう一度お試しください。"; }
        await editOriginalResponse(it.applicationId!, it.token!, reply);
      })();
      waitUntil(c, work);
      return c.json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    }
    default:
      return c.json(msg(helpMessage()));
  }
});

const COMMAND_MODULE_HINT = "ダッシュボード, スケジュール, アイデア, メモ, 健康, トレーニング, 資産, カード, FX, お金, 明細, バックアップ, リクエスト, 設定";

function waitUntil(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, p: Promise<unknown>) {
  try { c.executionCtx.waitUntil(p); } catch { /* no execution context (tests) → the promise still runs */ }
}

/* =====================================================================================
 * Authenticated: settings page / e2e hooks  (mounted at /api/discord)
 * ===================================================================================== */
export const routes = new Hono<AppEnv>();

routes.get("/status", async (c) => {
  const user = c.get("user");
  const env: Env = c.env;
  const [link, channels, history] = await Promise.all([findLinkByUser(env, user.id), listChannels(env, user.id), getHistory(env, user.id, 1)]);
  return c.json({
    configured: discordConfig(env),
    ready: Boolean(env.DISCORD_PUBLIC_KEY && env.DISCORD_APPLICATION_ID && env.DISCORD_BOT_TOKEN),
    interactions_url: `${env.APP_ORIGIN.replace(/\/$/, "")}/api/integrations/discord/interactions`,
    invite_url: env.DISCORD_APPLICATION_ID ? `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APPLICATION_ID}&scope=bot%20applications.commands&permissions=2048` : null,
    link: link ? { discord_user_id: link.discord_user_id, created_at: link.created_at } : null,
    channels,
    commands: COMMAND_DEFINITIONS.map((d) => ({ name: d.name, description: d.description, options: (d.options ?? []).map((o) => o.name) })),
    has_history: history.length > 0,
    gateway_note: "Cloudflare Workers はDiscord gatewayに常駐できないため、メンションや通常発言には反応しません。会話は /chat を使います。",
  });
});

routes.post("/register-commands", async (c) => {
  const r = await registerCommands(c.env);
  return c.json(r, r.ok ? 200 : 400);
});

routes.post("/link-code", async (c) => {
  const user = c.get("user");
  const r = await createLinkCode(c.env, user.id, generateLinkCode());
  return c.json({ ...r, ttl_sec: 600, command: `/link code:${r.code}` });
});

routes.delete("/link", async (c) => {
  await unlink(c.env, c.get("user").id);
  return c.json({ ok: true });
});

routes.get("/history", async (c) => c.json({ items: await getHistory(c.env, c.get("user").id, 50) }));

routes.post("/reset", async (c) => {
  await resetHistory(c.env, c.get("user").id);
  return c.json({ ok: true });
});

routes.post("/simulate", async (c) => {
  const user = c.get("user");
  const body = z.object({ text: z.string().min(1).max(2000) }).parse(await c.req.json());
  const r = await handleMessage(c.env, user.id, body.text);
  return c.json({ message: r.reply, ...r });
});
