// Appearance prefs shared by the settings API (validation) and the frontend (normalisation).
// Stored per user in the generic `settings` table: key "ui_design" → { design }, key "tab_bar" → { keys: string[] }.

export const DESIGN_THEMES = ["standard", "glass", "material"] as const;
export type DesignTheme = (typeof DESIGN_THEMES)[number];
export const DESIGN_LABELS: Record<DesignTheme, string> = { standard: "スタンダード", glass: "グラス", material: "マテリアル" };
export const isDesignTheme = (v: unknown): v is DesignTheme => typeof v === "string" && (DESIGN_THEMES as readonly string[]).includes(v);
export const normalizeDesign = (v: unknown): DesignTheme => (isDesignTheme(v) ? v : "standard");

/** Mobile bottom tab bar: 3–5 modules, then a fixed "その他" entry that opens the drawer. */
export const TAB_BAR_MIN = 3;
export const TAB_BAR_MAX = 5;
export const TAB_BAR_DEFAULT = ["dashboard", "planner", "health", "training", "cards"] as const;

/**
 * Clean up a stored/edited tab list: keep known module keys only, drop duplicates, cap at TAB_BAR_MAX,
 * and top up from the defaults (then from `valid` order) when fewer than TAB_BAR_MIN remain.
 */
export function normalizeTabBar(input: unknown, valid: readonly string[]): string[] {
  const known = new Set(valid);
  const out: string[] = [];
  for (const k of Array.isArray(input) ? input : []) {
    if (typeof k === "string" && known.has(k) && !out.includes(k)) out.push(k);
    if (out.length === TAB_BAR_MAX) break;
  }
  for (const k of [...TAB_BAR_DEFAULT, ...valid]) {
    if (out.length >= TAB_BAR_MIN) break;
    if (known.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}
