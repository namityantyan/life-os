import { useSyncExternalStore } from "react";
import { MODULES } from "@shared/types";
import { TAB_BAR_DEFAULT, normalizeTabBar } from "@shared/appearance";
import { api } from "@/lib/api";

/** Mobile bottom tab bar modules: localStorage cache for first paint, server (settings key "tab_bar") as the source of truth. */
/** Short labels for the mobile bottom tab bar (which modules appear there is a user setting: 設定 → 表示 → 下のバー). */
export const TAB_SHORT: Partial<Record<string, string>> = { dashboard: "ホーム", planner: "予定", health: "健康", training: "トレ", cards: "カード", assets: "資産", finance: "お金", royalty: "明細", backups: "バックアップ", requests: "要望", fx: "FX", images: "画像" };
const KEY = "lifeos.tabbar";
const validKeys = () => MODULES.map((m) => m.key as string);

export function readTabBar(raw: string | null, valid: readonly string[] = validKeys()): string[] {
  let v: unknown = null;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  return normalizeTabBar(Array.isArray(v) ? v : TAB_BAR_DEFAULT, valid);
}

let current: string[] = (() => { try { return readTabBar(localStorage.getItem(KEY)); } catch { return normalizeTabBar(TAB_BAR_DEFAULT, validKeys()); } })();
const listeners = new Set<() => void>();

export function setTabBar(keys: string[], opts: { sync?: boolean } = {}) {
  const next = normalizeTabBar(keys, validKeys());
  if (next.join() === current.join()) return;
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  listeners.forEach((l) => l());
  if (opts.sync === false) return;
  // Debounced so a drag that moves through several positions saves once.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { api.put("/settings/tab_bar", { keys: current }).catch(() => { /* offline: cached locally */ }); }, 400);
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useTabBar = () => useSyncExternalStore(subscribe, () => current, () => current);
