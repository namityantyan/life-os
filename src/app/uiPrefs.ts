// Pure (DOM-free) UI prefs parsing so it can be unit-tested and mirrored by the inline boot script in index.html.
import { normalizeDesign, type DesignTheme } from "@shared/appearance";

export type ThemeMode = "light" | "dark" | "system";
export type UiPrefs = { theme: ThemeMode; design: DesignTheme; fontScale: number; spaceScale: number; radiusScale: number; reduceMotion: boolean };
export const UI_PREFS_KEY = "lifeos.ui";
export const DEFAULT_UI_PREFS: UiPrefs = { theme: "system", design: "standard", fontScale: 1, spaceScale: 1, radiusScale: 1, reduceMotion: false };

const num = (v: unknown, min: number, max: number, fb: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb);

/** Parse the localStorage value; unknown/missing fields fall back to defaults, numbers are clamped to the slider ranges. */
export function parseUiPrefs(raw: string | null | undefined): UiPrefs {
  let o: Record<string, unknown> = {};
  try { const j = raw ? JSON.parse(raw) : {}; if (j && typeof j === "object" && !Array.isArray(j)) o = j; } catch { /* corrupt → defaults */ }
  const d = DEFAULT_UI_PREFS;
  return {
    theme: o.theme === "light" || o.theme === "dark" || o.theme === "system" ? o.theme : d.theme,
    design: normalizeDesign(o.design),
    fontScale: num(o.fontScale, 0.85, 1.3, d.fontScale),
    spaceScale: num(o.spaceScale, 0.8, 1.3, d.spaceScale),
    radiusScale: num(o.radiusScale, 0.5, 1.5, d.radiusScale),
    reduceMotion: typeof o.reduceMotion === "boolean" ? o.reduceMotion : d.reduceMotion,
  };
}
export const serializeUiPrefs = (p: UiPrefs) => JSON.stringify(p);
export const resolveMode = (mode: ThemeMode, systemDark: boolean): "light" | "dark" => (mode === "system" ? (systemDark ? "dark" : "light") : mode);

/** Browser chrome color (meta theme-color) per design × mode; matches --bg-solid in app.css. */
export const THEME_COLOR: Record<DesignTheme, Record<"light" | "dark", string>> = {
  standard: { light: "#f5f5f7", dark: "#000000" },
  glass: { light: "#e3f4f4", dark: "#0b1e26" },
  material: { light: "#f8fafd", dark: "#131314" },
};
