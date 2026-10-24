import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { api } from "@/lib/api";
import { DEFAULT_UI_PREFS, THEME_COLOR, UI_PREFS_KEY, parseUiPrefs, resolveMode, serializeUiPrefs, type ThemeMode, type UiPrefs } from "./uiPrefs";

export type { ThemeMode, UiPrefs } from "./uiPrefs";
/** sync: false = apply locally only (used when the value just came from the server). */
type SetOpts = { sync?: boolean };
type Ctx = { prefs: UiPrefs; setPrefs: (p: Partial<UiPrefs>, opts?: SetOpts) => void; resolvedTheme: "light" | "dark" };
const ThemeCtx = createContext<Ctx>({ prefs: DEFAULT_UI_PREFS, setPrefs: () => {}, resolvedTheme: "light" });

function load(): UiPrefs { try { return parseUiPrefs(localStorage.getItem(UI_PREFS_KEY)); } catch { return DEFAULT_UI_PREFS; } }

/** Writes prefs onto <html>: data-theme (light/dark), data-design (standard/glass/material), scale variables. index.html runs the same before first paint. */
export function applyPrefs(p: UiPrefs) {
  const root = document.documentElement;
  const resolved = resolveMode(p.theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = resolved;
  root.dataset.design = p.design;
  root.style.setProperty("--ui-font-scale", String(p.fontScale));
  root.style.setProperty("--ui-space-scale", String(p.spaceScale));
  root.style.setProperty("--ui-radius-scale", String(p.radiusScale));
  root.dataset.reduceMotion = p.reduceMotion ? "1" : "0";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[p.design][resolved]);
  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [prefs, setState] = useState<UiPrefs>(load);
  const [resolvedTheme, setResolved] = useState<"light" | "dark">(() => (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  useEffect(() => {
    setResolved(applyPrefs(prefs));
    try { localStorage.setItem(UI_PREFS_KEY, serializeUiPrefs(prefs)); } catch { /* private mode */ }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => setResolved(applyPrefs(prefs));
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, [prefs]);
  // Material press feedback: the ripple in app.css grows from the pointer position.
  useEffect(() => {
    const h = (e: PointerEvent) => {
      if (document.documentElement.dataset.design !== "material") return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(".pressable"); if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--rx", `${e.clientX - r.left}px`); el.style.setProperty("--ry", `${e.clientY - r.top}px`);
    };
    window.addEventListener("pointerdown", h, { passive: true });
    return () => window.removeEventListener("pointerdown", h);
  }, []);
  const setPrefs = useCallback((p: Partial<UiPrefs>, opts: SetOpts = {}) => {
    setState((s) => ({ ...s, ...p }));
    // The design is per user (server); mode and scales stay per device.
    if (p.design && opts.sync !== false) api.put("/settings/ui_design", { design: p.design }).catch(() => { /* offline: localStorage still has it */ });
  }, []);
  const value = useMemo<Ctx>(() => ({ prefs, resolvedTheme, setPrefs }), [prefs, resolvedTheme, setPrefs]);
  return <ThemeCtx.Provider value={value}><MotionConfig reducedMotion={prefs.reduceMotion ? "always" : "user"}>{children}</MotionConfig></ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);
