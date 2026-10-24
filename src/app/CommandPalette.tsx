import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { MODULES, type ModuleKey } from "@shared/types";
import { api } from "@/lib/api";
import { cx, useToast } from "@/components/ui";
import { useTheme, type ThemeMode } from "./theme";
import { Icon, ModuleIcon } from "@/components/icons";
import { DESIGN_LABELS, DESIGN_THEMES } from "@shared/appearance";

/** Search aliases per module (lower-case, NFKC-normalised at match time). */
const ALIASES: Partial<Record<ModuleKey | (string & {}), string[]>> = {
  dashboard: ["home", "ホーム", "トップ", "dash", "今日"],
  planner: ["予定", "スケジュール", "タスク", "カレンダー", "リマインド", "calendar", "todo", "task", "schedule"],
  ideas: ["アイデア", "idea", "ひらめき", "インボックス", "inbox"],
  notes: ["メモ", "note", "方針", "決定", "約束", "好み"],
  health: ["健康", "体調", "oura", "睡眠", "気圧", "食事", "美容", "health", "からだ", "検診"],
  training: ["筋トレ", "トレーニング", "ジム", "workout", "gym", "training", "運動"],
  assets: ["資産", "assets", "口座", "残高", "freee"],
  cards: ["カード", "card", "クレカ", "利用", "予算"],
  fx: ["fx", "為替", "シグナル", "mt5", "ドル円", "トレード"],
  finance: ["お金", "finance", "請求", "源泉", "fp", "money", "請求書", "領収書"],
  royalty: ["明細", "印税", "著作権", "royalty", "jasrac", "nextone"],
  images: ["画像生成", "画像", "イラスト", "生成", "image", "images", "絵"],
  backups: ["バックアップ", "backup", "dropbox"],
  requests: ["リクエスト", "要望", "request", "機能"],
  settings: ["設定", "settings", "通知", "天気", "接続", "表示", "端末"],
};

type Cmd = { id: string; group: string; label: string; hint?: string; icon: ReactNode; keywords: string[]; run: () => Promise<void> | void };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();
/** 0 = no match, higher = better. Exact > prefix > substring > subsequence. */
function score(q: string, candidates: string[]): number {
  let best = 0;
  for (const c0 of candidates) {
    const c = norm(c0);
    if (!c) continue;
    if (c === q) best = Math.max(best, 100);
    else if (c.startsWith(q)) best = Math.max(best, 80);
    else if (c.includes(q)) best = Math.max(best, 60);
    else if (q.length >= 2 && subsequence(q, c)) best = Math.max(best, 20);
  }
  return best;
}
function subsequence(q: string, c: string) { let i = 0; for (const ch of c) if (ch === q[i]) { i++; if (i === q.length) return true; } return false; }

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { prefs, setPrefs } = useTheme();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  // ⌘K / Ctrl+K toggles; Esc closes.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onOpenChange(!open); }
      else if (e.key === "Escape" && open) { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onOpenChange, close]);
  // ↑↓ Enter work while the palette is open, wherever focus is (the input focuses a tick after opening).
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(commandsRef.current.length - 1, i + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); const c = commandsRef.current[idxRef.current]; if (c) execRef.current(c); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);
  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  const done = (msg: string) => { toast(msg, "success"); window.dispatchEvent(new CustomEvent("lifeos:refresh")); close(); };

  const commands = useMemo<Cmd[]>(() => {
    const text = q.trim();
    const modules: Cmd[] = MODULES.map((m) => ({
      id: `mod-${m.key}`, group: "移動", label: m.label, hint: m.path, icon: <ModuleIcon module={m.key} size={18} />,
      keywords: [m.label, m.key, m.path, m.group, ...(ALIASES[m.key] ?? [])],
      run: () => { nav(m.path); close(); },
    }));
    const quick: Cmd[] = text ? [
      { id: "task", group: "クイック操作", label: `タスクを追加: ${text}`, icon: <Icon name="task" size={18} />, keywords: ["タスク", "task", "todo", text], run: async () => { await api.post("/planner", { type: "task", title: text }); done("タスクを追加しました"); } },
      { id: "idea", group: "クイック操作", label: `アイデアを保存: ${text}`, icon: <Icon name="ideas" size={18} />, keywords: ["アイデア", "idea", text], run: async () => { await api.post("/ideas", { raw_text: text }); done("アイデアを保存しました"); } },
      { id: "note", group: "クイック操作", label: `メモ: ${text}`, icon: <Icon name="notes" size={18} />, keywords: ["メモ", "note", text], run: async () => { await api.post("/notes", { category: "other", content: text }); done("メモを保存しました"); } },
    ] : [];
    const actions: Cmd[] = [
      { id: "pressure", group: "記録", label: "今しんどい", hint: "気圧の体調ログを記録", icon: <Icon name="gauge" size={18} />, keywords: ["しんどい", "つらい", "体調", "気圧", "頭痛", "pressure"], run: async () => { await api.post("/health/pressure/logs", {}); done("体調ログを記録しました"); } },
      ...(["light", "dark", "system"] as ThemeMode[]).map((t) => ({
        id: `theme-${t}`, group: "テーマ", label: `テーマ: ${{ light: "ライト", dark: "ダーク", system: "システム" }[t]}`, hint: prefs.theme === t ? "現在" : undefined, icon: <Icon name={t === "dark" ? "moon" : t === "light" ? "sun" : "system"} size={18} />,
        keywords: ["テーマ", "theme", t, { light: "ライト 明るい", dark: "ダーク 暗い", system: "システム 自動" }[t]],
        run: () => { setPrefs({ theme: t }); toast(`テーマを${{ light: "ライト", dark: "ダーク", system: "システム" }[t]}にしました`); close(); },
      })),
      ...DESIGN_THEMES.map((d) => ({
        id: `design-${d}`, group: "テーマ", label: `デザイン: ${DESIGN_LABELS[d]}`, hint: prefs.design === d ? "現在" : undefined, icon: <Icon name="theme" size={18} />,
        keywords: ["デザイン", "design", "見た目", d, DESIGN_LABELS[d], { standard: "標準 アップル", glass: "ガラス 透明 爽やか", material: "マテリアル google グーグル" }[d]],
        run: () => { setPrefs({ design: d }); toast(`デザインを${DESIGN_LABELS[d]}にしました`); close(); },
      })),
    ];
    if (!text) return [...modules, ...actions];
    const nq = norm(text);
    const scored = [...modules, ...actions].map((c) => ({ c, s: score(nq, c.keywords) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    // Quick actions always available for free text; they lead when nothing else matches well.
    const strong = scored.filter((x) => x.s >= 60).map((x) => x.c);
    const weak = scored.filter((x) => x.s < 60).map((x) => x.c);
    return [...strong, ...quick, ...weak];
  }, [q, nav, close, prefs.theme, prefs.design, setPrefs, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" }); }, [idx]);

  const exec = async (c: Cmd) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await c.run(); } catch (e: any) { toast(e?.message ?? "失敗しました", "error"); } finally { busyRef.current = false; setBusy(false); }
  };
  const commandsRef = useRef(commands); commandsRef.current = commands;
  const idxRef = useRef(idx); idxRef.current = idx;
  const execRef = useRef(exec); execRef.current = exec;

  let lastGroup = "";
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[10vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }}>
          <div className="scrim absolute inset-0" onClick={close} />
          <motion.div role="dialog" aria-modal="true" aria-label="コマンド" data-testid="command-palette"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
            className="popover relative w-full max-w-xl rounded-[var(--radius-xl)] overflow-hidden">
            <div className="flex items-center gap-3 px-4 h-14 border-b border-separator">
              <Icon name="search" className="text-label-3 shrink-0" />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="移動、タスク、アイデア、メモ…" aria-label="コマンドを検索" data-testid="palette-input"
                className="flex-1 bg-transparent outline-none text-lg placeholder:text-label-3" autoComplete="off" spellCheck={false} />
              {busy ? <span className="inline-block size-4 rounded-full border-2 border-current border-t-transparent animate-spin text-label-3" /> : <kbd className="hidden sm:inline text-xs text-label-3 bg-fill rounded px-1.5 py-0.5">esc</kbd>}
            </div>
            <ul ref={listRef} role="listbox" className="max-h-[56vh] overflow-auto p-2" data-testid="palette-list">
              {commands.length === 0 && <li className="px-3 py-8 text-center text-sm text-label-3">該当なし</li>}
              {commands.map((c, i) => {
                const header = c.group !== lastGroup ? c.group : null; lastGroup = c.group;
                return (
                  <li key={c.id} data-idx={i}>
                    {header && <div className="px-3 pt-2 pb-1 text-xs font-semibold text-label-3">{header}</div>}
                    <button type="button" role="option" aria-selected={i === idx} data-testid={`palette-item-${c.id}`} onMouseEnter={() => setIdx(i)} onClick={() => exec(c)}
                      className={cx("w-full flex items-center gap-3 px-3 h-11 rounded-[var(--radius-md)] text-left text-base transition-colors", i === idx ? "bg-accent-soft text-label" : "text-label-2 hover:bg-fill")}>
                      <span className="w-5 grid place-items-center shrink-0">{c.icon}</span>
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.hint && <span className="text-xs text-label-3 shrink-0">{c.hint}</span>}
                      {i === idx && <Icon name="enter" size={16} className="hidden sm:block text-label-3 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
