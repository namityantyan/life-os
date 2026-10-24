import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { MODULES, type ModuleKey } from "@shared/types";
import { useAuth } from "./auth";
import { cx, IconButton } from "@/components/ui";
import { NotificationBell } from "./NotificationBell";
import { CommandPalette } from "./CommandPalette";
import { AssistantPanel } from "./AssistantPanel";

/** Modules reachable from the mobile bottom tab bar; everything else stays in the drawer. */
const TAB_KEYS: ModuleKey[] = ["dashboard", "planner", "health", "training", "cards"];
const TAB_SHORT: Partial<Record<ModuleKey, string>> = { dashboard: "ホーム", planner: "予定", health: "健康", training: "トレ", cards: "カード" };

const ICONS: Record<ModuleKey, string> = {
  dashboard: "◉", planner: "▦", ideas: "✦", notes: "≡", health: "♥", training: "⚡", assets: "◈", cards: "▭", fx: "⇅", finance: "¥", royalty: "♪", images: "◐", backups: "☁", requests: "✎", settings: "⚙",
};

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("lifeos.sidebar") === "1"; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const loc = useLocation();
  const { user, logout } = useAuth();
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => { try { localStorage.setItem("lifeos.sidebar", collapsed ? "1" : "0"); } catch { /* ignore */ } }, [collapsed]);
  // Edge swipe to open on mobile
  useEffect(() => {
    let startX = -1;
    const ts = (e: TouchEvent) => { startX = e.touches[0].clientX < 24 ? e.touches[0].clientX : -1; };
    const te = (e: TouchEvent) => { if (startX >= 0 && e.changedTouches[0].clientX - startX > 60) setDrawer(true); startX = -1; };
    window.addEventListener("touchstart", ts, { passive: true }); window.addEventListener("touchend", te);
    return () => { window.removeEventListener("touchstart", ts); window.removeEventListener("touchend", te); };
  }, []);
  const current = MODULES.find((m) => (m.path === "/" ? loc.pathname === "/" : loc.pathname.startsWith(m.path)));
  const groups = Array.from(new Set(MODULES.map((m) => m.group)));

  const nav = (compact: boolean) => (
    <nav className="flex-1 overflow-auto px-2 py-2 space-y-4" aria-label="モジュール">
      {groups.map((g) => (
        <div key={g}>
          {!compact && <div className="px-3 pb-1 text-xs font-semibold text-label-3 uppercase tracking-wide">{g}</div>}
          <ul className="space-y-0.5">
            {MODULES.filter((m) => m.group === g).map((m) => (
              <li key={m.key}>
                <NavLink to={m.path} end={m.path === "/"} title={m.label} data-testid={`nav-${m.key}`} className={({ isActive }) => cx("relative flex items-center gap-3 h-9 rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors", isActive ? "text-label" : "text-label-2 hover:text-label hover:bg-fill", compact && "justify-center px-0")}>
                  {({ isActive }) => (<>
                    {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-[var(--radius-md)] bg-fill" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                    <span className="relative w-5 text-center text-base opacity-80">{ICONS[m.key]}</span>
                    {!compact && <span className="relative">{m.label}</span>}
                  </>)}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-dvh flex">
      {/* Desktop sidebar */}
      <motion.aside animate={{ width: collapsed ? 64 : 232 }} transition={{ type: "spring", stiffness: 300, damping: 32 }} className="hidden md:flex flex-col shrink-0 border-r border-separator bg-grouped sticky top-0 h-dvh overflow-hidden" data-testid="sidebar">
        <div className={cx("flex items-center h-14 px-3", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && <span className="font-bold tracking-tight pl-1">Life OS</span>}
          <IconButton label={collapsed ? "サイドバーを広げる" : "サイドバーを畳む"} onClick={() => setCollapsed((v) => !v)} data-testid="sidebar-toggle">{collapsed ? "›" : "‹"}</IconButton>
        </div>
        {nav(collapsed)}
        <div className={cx("p-3 border-t border-separator flex items-center gap-2", collapsed && "justify-center")}>
          {user?.picture ? <img src={user.picture} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" /> : <span className="size-8 rounded-full bg-fill grid place-items-center text-xs">{(user?.name ?? user?.email ?? "?").slice(0, 1)}</span>}
          {!collapsed && <div className="min-w-0 flex-1"><div className="text-sm truncate">{user?.name ?? "—"}</div><button className="text-xs text-label-2 hover:text-label" onClick={logout}>ログアウト</button></div>}
        </div>
      </motion.aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawer && (
          <motion.div className="fixed inset-0 z-40 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
            <motion.aside initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} transition={{ type: "spring", stiffness: 400, damping: 36 }} className="absolute left-0 top-0 h-full w-64 bg-grouped flex flex-col shadow-[var(--shadow-pop)]" data-testid="drawer">
              <div className="h-14 flex items-center px-4 font-bold">Life OS</div>
              {nav(false)}
              <div className="p-3 border-t border-separator text-sm"><button onClick={logout} className="text-label-2">ログアウト</button></div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="glass sticky top-0 z-30 h-14 flex items-center gap-2 px-3 md:px-6 border-b border-separator">
          <IconButton label="メニュー" className="md:hidden" onClick={() => setDrawer(true)} data-testid="menu-button">☰</IconButton>
          <div className="font-semibold tracking-tight md:text-label-2 md:font-medium">{current?.label ?? "Life OS"}</div>
          <div className="flex-1" />
          <IconButton label="検索・コマンド（⌘K）" onClick={() => setPalette(true)} data-testid="palette-button">⌕</IconButton>
          <IconButton label="アシスタント（⌘J）" onClick={() => setAssistant(true)} data-testid="assistant-button">✧</IconButton>
          <NotificationBell />
        </header>
        <main className="flex-1 px-4 md:px-8 pt-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-6 max-w-[1400px] w-full mx-auto">
          <AnimatePresence mode="wait">
            <motion.div key={loc.pathname.split("/")[1]} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
              {children}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 glass border-t border-separator pb-[env(safe-area-inset-bottom)]" aria-label="主要モジュール" data-testid="tabbar">
          <ul className="grid grid-cols-5 h-14">
            {TAB_KEYS.map((k) => {
              const m = MODULES.find((x) => x.key === k)!;
              return (
                <li key={k} className="min-w-0">
                  <NavLink to={m.path} end={m.path === "/"} data-testid={`tab-${k}`} aria-label={m.label} className={({ isActive }) => cx("relative h-full flex flex-col items-center justify-center gap-0.5 text-xs font-medium select-none", isActive ? "text-accent" : "text-label-2")}>
                    {({ isActive }) => (<>
                      {isActive && <motion.span layoutId="tab-active" data-testid="tab-indicator" className="absolute top-1 w-9 h-1 rounded-full bg-accent" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                      <span className="text-xl leading-none">{ICONS[k]}</span>
                      <span className="truncate max-w-full">{TAB_SHORT[k] ?? m.label}</span>
                    </>)}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <AssistantPanel open={assistant} onOpenChange={setAssistant} />
    </div>
  );
}
