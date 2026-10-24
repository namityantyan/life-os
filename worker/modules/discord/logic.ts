// Pure helpers for the Discord BOT (no D1 / fetch) so they are unit-testable.
import { MODULES, type ModuleKey } from "../../../shared/types";

/* ---------- Discord constants ---------- */
export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 } as const;
export const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5 } as const;
export const EPHEMERAL = 64;
export const DISCORD_MAX_CONTENT = 2000;

export type CommandName = "chat" | "dash" | "dashboard" | "chathere" | "chatstatus" | "chatoff" | "link" | "reset";

/** Global slash command definitions (used by registerCommands and documented in docs/discord.md). */
export const COMMAND_DEFINITIONS: { name: CommandName; description: string; options?: { name: string; description: string; type: number; required?: boolean }[] }[] = [
  { name: "chat", description: "生活管理BOTと会話する（筋トレなどの記録も自然文でOK）", options: [{ name: "text", description: "話しかける内容", type: 3, required: true }] },
  { name: "dash", description: "Life OSの画面へのリンクを取得", options: [{ name: "module", description: "画面名（例: 資産, training）", type: 3, required: false }] },
  { name: "dashboard", description: "Life OSのダッシュボードへのリンクを取得" },
  { name: "chathere", description: "このチャンネルを会話用チャンネルに設定" },
  { name: "chatstatus", description: "会話用チャンネルの設定を確認" },
  { name: "chatoff", description: "会話用チャンネルの設定を解除" },
  { name: "link", description: "Life OSのアカウントと連携する", options: [{ name: "code", description: "設定画面で発行した連携コード", type: 3, required: true }] },
  { name: "reset", description: "BOTとの会話履歴をリセット（チャンネル設定は保持）" },
];

/* ---------- Interaction payload parsing ---------- */
export type DiscordUser = { id: string; username?: string; bot?: boolean; system?: boolean };
export type Interaction = {
  id?: string; type: number; token?: string; application_id?: string;
  guild_id?: string; channel_id?: string;
  member?: { user?: DiscordUser }; user?: DiscordUser;
  data?: { name?: string; options?: { name: string; value?: unknown; type?: number }[] };
  message?: { author?: DiscordUser & { webhook_id?: string }; webhook_id?: string };
};

export type ParsedInteraction =
  | { kind: "ping" }
  | { kind: "command"; name: string; options: Record<string, string>; guildId: string | null; channelId: string | null; user: DiscordUser | null; token: string | null; applicationId: string | null }
  | { kind: "unknown"; type: number };

export function parseInteraction(raw: unknown): ParsedInteraction {
  const i = (raw ?? {}) as Interaction;
  if (i.type === InteractionType.PING) return { kind: "ping" };
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const options: Record<string, string> = {};
    for (const o of i.data?.options ?? []) if (o && typeof o.name === "string" && o.value != null) options[o.name] = String(o.value);
    return {
      kind: "command",
      name: String(i.data?.name ?? "").toLowerCase(),
      options,
      guildId: i.guild_id ?? null,
      channelId: i.channel_id ?? null,
      user: i.member?.user ?? i.user ?? null,
      token: i.token ?? null,
      applicationId: i.application_id ?? null,
    };
  }
  return { kind: "unknown", type: Number(i.type ?? 0) };
}

/** Messages authored by bots or webhooks must never trigger a reply (no conversation chains). */
export function isFromBot(author: { bot?: boolean; system?: boolean; webhook_id?: string | null } | null | undefined, webhookId?: string | null): boolean {
  if (webhookId) return true;
  if (!author) return false;
  return Boolean(author.bot || author.system || author.webhook_id);
}

/* ---------- Dashboard link resolution ---------- */
const MODULE_ALIASES: Record<string, ModuleKey> = {
  "ダッシュボード": "dashboard", "ダッシュ": "dashboard", "ホーム": "dashboard", "トップ": "dashboard", "dashboard": "dashboard", "dash": "dashboard", "home": "dashboard",
  "スケジュール": "planner", "予定": "planner", "タスク": "planner", "カレンダー": "planner", "planner": "planner", "schedule": "planner",
  "アイデア": "ideas", "ideas": "ideas", "idea": "ideas",
  "メモ": "notes", "ノート": "notes", "notes": "notes", "note": "notes",
  "健康": "health", "睡眠": "health", "食事": "health", "美容": "health", "health": "health", "oura": "health",
  "トレーニング": "training", "筋トレ": "training", "training": "training", "workout": "training",
  "資産": "assets", "assets": "assets", "asset": "assets",
  "カード": "cards", "カード利用": "cards", "cards": "cards", "card": "cards",
  "fx": "fx", "FX": "fx", "シグナル": "fx", "為替": "fx",
  "お金": "finance", "家計": "finance", "finance": "finance", "money": "finance",
  "明細": "royalty", "著作権": "royalty", "royalty": "royalty",
  "画像生成": "images", "画像": "images", "images": "images",
  "バックアップ": "backups", "backups": "backups", "backup": "backups",
  "リクエスト": "requests", "要望": "requests", "requests": "requests", "request": "requests",
  "設定": "settings", "settings": "settings", "setting": "settings",
};

export function moduleByKey(key: ModuleKey) { return MODULES.find((m) => m.key === key)!; }

/** Resolve a module name / alias (e.g. "資産", "training") to a module. Empty → dashboard. */
export function resolveModule(name: string | null | undefined): (typeof MODULES)[number] | null {
  const q = (name ?? "").trim();
  if (!q) return moduleByKey("dashboard");
  const lower = q.toLowerCase();
  if (MODULE_ALIASES[q]) return moduleByKey(MODULE_ALIASES[q]);
  if (MODULE_ALIASES[lower]) return moduleByKey(MODULE_ALIASES[lower]);
  const byLabel = MODULES.find((m) => m.label === q || m.key === lower);
  if (byLabel) return byLabel;
  // longest alias contained in the query
  const hit = Object.keys(MODULE_ALIASES).filter((a) => a.length >= 2 && (q.includes(a) || lower.includes(a.toLowerCase()))).sort((a, b) => b.length - a.length)[0];
  return hit ? moduleByKey(MODULE_ALIASES[hit]) : null;
}

/** Natural-language request for a screen link such as "資産のURL" / "ダッシュボードのリンク" / "dash". Returns the path or null. */
export function resolveDashboardLink(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[!/]?(dash|dashboard)\s*$/i.test(t)) return "/";
  const m = t.match(/^[!/]?(?:dash|dashboard)\s+(.+)$/i);
  if (m) return resolveModule(m[1])?.path ?? null;
  if (!/(url|URL|リンク|link|画面|ページ|開き|を見|見せて|ダッシュボード)/.test(t)) return null;
  const mod = resolveModule(t);
  if (mod) return mod.path;
  return /ダッシュボード/.test(t) ? "/" : null;
}

export function moduleUrl(origin: string, path: string) { return `${origin.replace(/\/$/, "")}${path}`; }

/* ---------- Training phrase detection (routes to training.logFromText first) ---------- */
const TRAINING_RE = /筋トレ|ベンチ|スクワット|デッドリフト|懸垂|腕立て|腹筋|背筋|ダンベル|バーベル|プレス|カール|ラットプル|レッグ|ショルダー|チンニング|ローイング|\d+\s*(kg|キロ)|\d+\s*(回|レップ|rep)|\d+\s*セット|ジム(に|で|行)|トレーニング(を|した|やった|開始|終了|始め|終わ)|トレ(開始|終了|始め|終わ)|^(終了|開始|終わり|おわり|始める)(です|しました|した|！|!|。)?$/i;
export function isTrainingPhrase(text: string): boolean { return TRAINING_RE.test(text); }

/* ---------- Misc ---------- */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function generateLinkCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}
export function normalizeLinkCode(code: string) { return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }

export function truncateForDiscord(text: string, max = DISCORD_MAX_CONTENT): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Reply used when the Discord user is not linked yet. */
export function notLinkedMessage(origin: string) {
  return `このDiscordアカウントはまだLife OSと連携されていません。\n${moduleUrl(origin, "/settings")} の「Discord BOT」で連携コードを発行し、\`/link code:XXXXXX\` を実行してください（コードは10分間有効）。`;
}

export function helpMessage() {
  return [
    "使えるコマンド:",
    ...COMMAND_DEFINITIONS.map((c) => `/${c.name}${(c.options ?? []).map((o) => ` ${o.name}`).join("")} — ${c.description}`),
    "チャンネルでの通常発言やメンションには反応できません（Discord Interactions方式のため）。会話は /chat を使ってください。",
  ].join("\n");
}
