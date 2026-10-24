import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { MODULES } from "@shared/types";
import { useAuth } from "./auth";
import { cx, IconButton } from "@/components/ui";
import { Icon, ModuleIcon } from "@/components/icons";
import { NotificationBell } from "./NotificationBell";
import { CommandPalette } from "./CommandPalette";
import { AssistantPanel } from "./AssistantPanel";
import { TAB_SHORT, useTabBar } from "./tabBar";
import { prefetchModule, prefetchModules } from "./prefetch";
import { useAppearanceSync } from "./appearanceSync";

const navTransition = { duration: 0.18, ease: [0.2, 0.8, 0.2, 1] as const };

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => { try { return localStorage.getItem("lifeos.sidebar") === "1"; } catch { return false; } });
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const loc = useLocation();
  const { user, logout } = useAuth();
  const tabKeys = useTabBar();
  useAppearanceSync();
  useEffect(() => { prefetchModules(tabKeys); }, [tabKeys]);
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  const section = loc.pathname.split("/")[1];
  useEffect(() => { if (!window.location.hash) window.scrollTo(0, 0); }, [section]); // new module starts at the top
  useEffect(() => { try { localStorage.setItem("lifeos.sidebar", collapsed ? "1" : "0"); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => { if (!drawer) return; const h = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [drawer]);
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
    <nav className="flex-1 overflow-auto px-2 py-2 space-y-5" aria-label="モジュール">
      {groups.map((g) => (
        <div key={g}>
          {!compact && <div className="px-3 pb-1.5 text-xs font-medium text-label-3">{g}</div>}
          <ul className="space-y-0.5">
            {MODULES.filter((m) => m.group === g).map((m) => (
              <li key={m.key}>
                <NavLink to={m.path} end={m.path === "/"} title={m.label} data-testid={`nav-${m.key}`} onPointerEnter={() => prefetchModule(m.key)} onTouchStart={() => prefetchModule(m.key)} className={cx("nav-item focus-ring relative flex items-center gap-3 h-11 md:h-10 rounded-[var(--radius-md)] px-3 text-sm font-medium transition-colors", compact && "justify-center px-0")}>
                  {({ isActive }) => (<>
                    {isActive && <motion.span layoutId={compact ? "nav-active-c" : "nav-active"} className="nav-pill absolute inset-0 rounded-[var(--radius-md)]" transition={navTransition} />}
                    <ModuleIcon module={m.key} className="relative shrink-0" />
                    {!compact && <span className="relative truncate">{m.label}</span>}
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
      <motion.aside initial={false} animate={{ width: collapsed ? 68 : 236 }} transition={navTransition} className="sidebar hidden md:flex flex-col shrink-0 border-r sticky top-0 h-dvh overflow-hidden" data-testid="sidebar">
        <div className={cx("flex items-center h-14 px-3", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && <span className="font-bold tracking-tight pl-1">Life OS</span>}
          <IconButton label={collapsed ? "サイドバーを広げる" : "サイドバーを畳む"} onClick={() => setCollapsed((v) => !v)} data-testid="sidebar-toggle"><Icon name={collapsed ? "chevron-right" : "chevron-left"} size={18} /></IconButton>
        </div>
        {nav(collapsed)}
        <div className={cx("p-3 border-t border-separator flex items-center gap-2", collapsed && "justify-center")}>
          {user?.picture ? <img src={user.picture} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" /> : <span className="size-8 rounded-full bg-fill grid place-items-center text-xs">{(user?.name ?? user?.email ?? "?").slice(0, 1)}</span>}
          {!collapsed && <div className="min-w-0 flex-1"><div className="text-sm truncate">{user?.name ?? "—"}</div><button className="focus-ring rounded text-xs text-label-2 hover:text-label" onClick={logout}>ログアウト</button></div>}
        </div>
      </motion.aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawer && (
          <motion.div className="fixed inset-0 z-40 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={navTransition}>
            <div className="scrim absolute inset-0" onClick={() => setDrawer(false)} />
            <motion.aside initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={navTransition} role="dialog" aria-modal="true" aria-label="メニュー"
              className="sheet absolute left-0 top-0 h-full w-72 max-w-[85vw] flex flex-col pt-[env(safe-area-inset-top)] rounded-r-[var(--radius-xl)]" data-testid="drawer">
              <div className="h-14 flex items-center justify-between pl-5 pr-2 font-bold">Life OS<IconButton label="メニューを閉じる" onClick={() => setDrawer(false)} data-testid="drawer-close"><Icon name="close" /></IconButton></div>
              {nav(false)}
              <div className="p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] border-t border-separator flex items-center gap-1 text-sm">
                <NavLink to="/settings#tabbar" className="focus-ring flex-1 min-w-0 h-11 px-3 rounded-[var(--radius-md)] flex items-center gap-2 text-label-2 hover:bg-fill"><Icon name="edit" size={18} className="shrink-0" /><span className="truncate">下のバーを編集</span></NavLink>
                <button onClick={logout} className="focus-ring h-11 px-3 rounded-[var(--radius-md)] flex items-center gap-2 text-label-2 hover:bg-fill"><Icon name="logout" size={18} />ログアウト</button>
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="chrome sticky top-0 z-30 h-14 flex items-center gap-1 px-2 md:px-6 border-b">
          <IconButton label="メニュー" className="md:hidden" onClick={() => setDrawer(true)} data-testid="menu-button"><Icon name="menu" /></IconButton>
          <div className="font-semibold tracking-tight truncate pl-1 md:pl-0 md:text-label-2 md:font-medium">{current?.label ?? "Life OS"}</div>
          <div className="flex-1" />
          <IconButton label="検索・コマンド（⌘K）" onClick={() => setPalette(true)} data-testid="palette-button"><Icon name="search" /></IconButton>
          <IconButton label="アシスタント（⌘J）" onClick={() => setAssistant(true)} data-testid="assistant-button"><Icon name="assistant" /></IconButton>
          <NotificationBell />
        </header>
        <main className="flex-1 px-4 md:px-8 pt-5 md:pt-7 pb-[calc(6.5rem+env(safe-area-inset-bottom))] md:pb-8 max-w-[1400px] w-full mx-auto">
          {/* Fade only and no exit wait, so the next page starts rendering immediately. */}
          <motion.div key={loc.pathname.split("/")[1]} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14 }}>
            {children}
          </motion.div>
        </main>

        {/* Mobile bottom tab bar: the user's 3–5 modules, then その他 (opens the drawer). */}
        <nav className="chrome md:hidden fixed bottom-0 inset-x-0 z-30 border-t pb-[env(safe-area-inset-bottom)]" aria-label="主要モジュール" data-testid="tabbar">
          <ul className="tabbar-row grid h-14" style={{ gridTemplateColumns: `repeat(${tabKeys.length + 1}, minmax(0, 1fr))` }}>
            {tabKeys.map((k) => {
              const m = MODULES.find((x) => x.key === k); if (!m) return null;
              return (
                <li key={k} className="min-w-0">
                  <NavLink to={m.path} end={m.path === "/"} data-testid={`tab-${k}`} onTouchStart={() => prefetchModule(k)} aria-label={m.label} className="tab-item focus-ring relative h-full flex flex-col items-center justify-center gap-1 text-xs font-medium select-none">
                    {({ isActive }) => (<>
                      {isActive && <motion.span layoutId="tab-active" data-testid="tab-indicator" className="tab-indicator" transition={navTransition} />}
                      <ModuleIcon module={k} size={22} className="relative" />
                      <span className="relative truncate max-w-full px-0.5">{TAB_SHORT[k] ?? m.label}</span>
                    </>)}
                  </NavLink>
                </li>
              );
            })}
            <li className="min-w-0">
              <button type="button" onClick={() => setDrawer(true)} data-testid="tab-more" aria-label="その他のモジュール" className="tab-item focus-ring relative w-full h-full flex flex-col items-center justify-center gap-1 text-xs font-medium select-none">
                <Icon name="more" size={22} className="relative" />
                <span className="relative">その他</span>
              </button>
            </li>
          </ul>
        </nav>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <AssistantPanel open={assistant} onOpenChange={setAssistant} />
    </div>
  );
}
