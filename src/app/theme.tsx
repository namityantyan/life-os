import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type UiPrefs = { theme: ThemeMode; fontScale: number; spaceScale: number; radiusScale: number; reduceMotion: boolean };
const DEFAULT: UiPrefs = { theme: "system", fontScale: 1, spaceScale: 1, radiusScale: 1, reduceMotion: false };
const KEY = "lifeos.ui";

type Ctx = { prefs: UiPrefs; setPrefs: (p: Partial<UiPrefs>) => void; resolvedTheme: "light" | "dark" };
const ThemeCtx = createContext<Ctx>({ prefs: DEFAULT, setPrefs: () => {}, resolvedTheme: "light" });

function load(): UiPrefs { try { return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<UiPrefs>) }; } catch { return DEFAULT; } }

export function applyPrefs(p: UiPrefs) {
  const root = document.documentElement;
  const sys = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = p.theme === "system" ? (sys ? "dark" : "light") : p.theme;
  root.dataset.theme = resolved;
  root.style.setProperty("--ui-font-scale", String(p.fontScale));
  root.style.setProperty("--ui-space-scale", String(p.spaceScale));
  root.style.setProperty("--ui-radius-scale", String(p.radiusScale));
  root.dataset.reduceMotion = p.reduceMotion ? "1" : "0";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#000000" : "#f5f5f7");
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setState] = useState<UiPrefs>(load);
  const [resolvedTheme, setResolved] = useState<"light" | "dark">("light");
  useEffect(() => {
    setResolved(applyPrefs(prefs));
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => setResolved(applyPrefs(prefs));
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [prefs]);
  const value = useMemo<Ctx>(() => ({ prefs, resolvedTheme, setPrefs: (p) => setState((s) => ({ ...s, ...p })) }), [prefs, resolvedTheme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);
