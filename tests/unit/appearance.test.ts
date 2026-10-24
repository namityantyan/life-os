import { describe, it, expect } from "vitest";
import { normalizeTabBar, normalizeDesign, TAB_BAR_DEFAULT, TAB_BAR_MAX, TAB_BAR_MIN } from "../../shared/appearance";
import { MODULES } from "../../shared/types";
import { readTabBar } from "../../src/app/tabBar";
import { parseUiPrefs, serializeUiPrefs, resolveMode, DEFAULT_UI_PREFS, THEME_COLOR } from "../../src/app/uiPrefs";
import { MODULE_ICONS, ICON_NAMES } from "../../src/components/icons";

const valid = MODULES.map((m) => m.key as string);

describe("tab bar prefs normalisation", () => {
  it("keeps a valid list as-is, in order", () => {
    expect(normalizeTabBar(["cards", "dashboard", "notes"], valid)).toEqual(["cards", "dashboard", "notes"]);
  });
  it("drops unknown keys and duplicates, caps at the maximum", () => {
    expect(normalizeTabBar(["notes", "nope", "notes", "fx", "ideas", "cards", "assets", "health"], valid)).toEqual(["notes", "fx", "ideas", "cards", "assets"]);
    expect(normalizeTabBar(valid, valid)).toHaveLength(TAB_BAR_MAX);
  });
  it("tops up from the defaults when fewer than the minimum remain", () => {
    expect(normalizeTabBar(["fx"], valid)).toEqual(["fx", "dashboard", "planner"]);
    expect(normalizeTabBar(["dashboard"], valid)).toEqual(["dashboard", "planner", "health"]);
    expect(normalizeTabBar([], valid)).toHaveLength(TAB_BAR_MIN);
  });
  it("treats non-arrays and non-strings as empty", () => {
    expect(normalizeTabBar(null, valid)).toEqual(["dashboard", "planner", "health"]);
    expect(normalizeTabBar({ keys: ["fx"] }, valid)).toEqual(["dashboard", "planner", "health"]);
    expect(normalizeTabBar([1, "fx", { k: 1 }, "cards", "notes"], valid)).toEqual(["fx", "cards", "notes"]);
  });
  it("accepts keys the caller knows about (e.g. a module added later)", () => {
    expect(normalizeTabBar(["images", "dashboard", "fx"], [...valid, "images"])).toEqual(["images", "dashboard", "fx"]);
    expect(normalizeTabBar(["images", "dashboard", "fx"], valid)).toEqual(["dashboard", "fx", "planner"]);
  });
  it("falls back from the valid list when the defaults are not available", () => {
    expect(normalizeTabBar([], ["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });
  it("readTabBar: default set when nothing cached or the cache is corrupt", () => {
    expect(readTabBar(null, valid)).toEqual([...TAB_BAR_DEFAULT]);
    expect(readTabBar("{not json", valid)).toEqual([...TAB_BAR_DEFAULT]);
    expect(readTabBar(JSON.stringify(["notes", "ideas", "fx", "fx"]), valid)).toEqual(["notes", "ideas", "fx"]);
  });
});

describe("theme persistence", () => {
  it("round-trips through serialise/parse", () => {
    const p = { ...DEFAULT_UI_PREFS, theme: "dark" as const, design: "glass" as const, fontScale: 1.15, reduceMotion: true };
    expect(parseUiPrefs(serializeUiPrefs(p))).toEqual(p);
  });
  it("keeps prefs saved before designs existed and defaults the design to standard", () => {
    expect(parseUiPrefs(JSON.stringify({ theme: "light", fontScale: 1.1, spaceScale: 1, radiusScale: 1, reduceMotion: false }))).toEqual({ ...DEFAULT_UI_PREFS, theme: "light", fontScale: 1.1 });
  });
  it("rejects unknown designs/modes and clamps scales", () => {
    const p = parseUiPrefs(JSON.stringify({ theme: "sepia", design: "neon", fontScale: 9, spaceScale: 0.1, radiusScale: "x", reduceMotion: "yes" }));
    expect(p).toEqual({ ...DEFAULT_UI_PREFS, fontScale: 1.3, spaceScale: 0.8 });
  });
  it("survives corrupt or empty storage", () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs("{oops")).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs("[1,2]")).toEqual(DEFAULT_UI_PREFS);
  });
  it("normalizeDesign / resolveMode", () => {
    expect(normalizeDesign("material")).toBe("material");
    expect(normalizeDesign(undefined)).toBe("standard");
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("light", true)).toBe("light");
  });
  it("has a browser chrome colour for every design and mode", () => {
    for (const d of ["standard", "glass", "material"] as const) for (const m of ["light", "dark"] as const) expect(THEME_COLOR[d][m]).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("icons", () => {
  it("every module (and the upcoming images module) has an existing icon", () => {
    for (const k of [...valid, "images"]) expect(ICON_NAMES).toContain(MODULE_ICONS[k]);
  });
});
