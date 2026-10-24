// Push notification preferences, grouped by module. Shared by the Worker (delivery) and the settings screen.
// The in-app bell always records every notification; these switches only decide what is pushed to devices.
import { NOTIFICATION_KINDS, type NotificationKind } from "./types";

export const NOTIFICATION_MODULES = [
  { key: "planner", label: "スケジュール", kinds: ["reminder"] },
  { key: "health", label: "健康", kinds: ["bedtime"] },
  { key: "training", label: "トレーニング", kinds: ["training"] },
  { key: "fx", label: "FXシグナル", kinds: ["fx"] },
  { key: "finance", label: "お金", kinds: ["invoice", "withholding"] },
  { key: "royalty", label: "明細", kinds: ["royalty"] },
  { key: "backups", label: "バックアップ", kinds: ["backup"] },
  { key: "images", label: "画像生成", kinds: ["images"] },
  { key: "dashboard", label: "ダッシュボード", kinds: ["morning", "weekly"] },
  { key: "system", label: "システム", kinds: ["system"] },
] as const satisfies readonly { key: string; label: string; kinds: readonly NotificationKind[] }[];

export type NotificationModuleKey = (typeof NOTIFICATION_MODULES)[number]["key"];
/** Setting "push_prefs". Push is sent when both the module and the kind are on. */
export type PushPrefs = { modules: Record<NotificationModuleKey, boolean>; kinds: Record<NotificationKind, boolean> };

export const moduleOfKind = (kind: NotificationKind): NotificationModuleKey =>
  NOTIFICATION_MODULES.find((m) => (m.kinds as readonly NotificationKind[]).includes(kind))?.key ?? "system";
const kindsOf = (key: NotificationModuleKey) => (NOTIFICATION_MODULES.find((m) => m.key === key)?.kinds ?? []) as readonly NotificationKind[];
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Fill every module/kind (new ones default to on). Without stored "push_prefs", the legacy
 * "notification_prefs" ({ kind: { push, discord } }) seeds the kinds; a module starts off only when all its kinds were off.
 */
export function normalizePushPrefs(stored: unknown, legacy?: unknown): PushPrefs {
  const s = rec(stored); const sm = rec(s.modules); const sk = rec(s.kinds); const l = rec(legacy);
  const hasStored = Object.keys(sm).length > 0 || Object.keys(sk).length > 0;
  const kinds = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, bool(sk[k]) ?? (hasStored ? true : bool(rec(l[k]).push) ?? true)])) as PushPrefs["kinds"];
  const modules = Object.fromEntries(NOTIFICATION_MODULES.map((m) => [m.key, bool(sm[m.key]) ?? (hasStored ? true : m.kinds.some((k) => kinds[k]))])) as PushPrefs["modules"];
  return { modules, kinds };
}

export const pushAllowed = (p: PushPrefs, kind: NotificationKind) => p.modules[moduleOfKind(kind)] !== false && p.kinds[kind] !== false;

/** Module switch. Turning a module on whose kinds are all off turns them all on, so the switch always does something. */
export function withModule(p: PushPrefs, key: NotificationModuleKey, on: boolean): PushPrefs {
  const ks = kindsOf(key);
  const kinds = on && !ks.some((k) => p.kinds[k]) ? { ...p.kinds, ...Object.fromEntries(ks.map((k) => [k, true])) } : p.kinds;
  return { modules: { ...p.modules, [key]: on }, kinds };
}

/** Kind switch. Turning a kind on also turns its module on; turning off the last kind turns the module off. */
export function withKind(p: PushPrefs, kind: NotificationKind, on: boolean): PushPrefs {
  const key = moduleOfKind(kind);
  const kinds = { ...p.kinds, [kind]: on };
  return { modules: { ...p.modules, [key]: on ? true : kindsOf(key).some((k) => kinds[k]) && p.modules[key] }, kinds };
}

/** Device name for the subscription list ("Mac Chrome", "Android", "iPhone"). Standalone = installed app. */
export function deviceLabel(ua: string, standalone = false): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux|CrOS/.test(ua) ? "Linux" : "端末";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const name = os === "iPhone" || os === "iPad" ? os : [os, browser].filter(Boolean).join(" ");
  return standalone ? `${name}（アプリ）` : name;
}
