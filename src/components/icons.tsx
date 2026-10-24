import type { ReactNode, SVGProps } from "react";

/* Life OS line icons — drawn for this app on a 24px grid.
   Rules: stroke = currentColor, 1.75px (scales with size), round caps & joins, no fills except tiny dot accents.
   Use <Icon name="..." /> anywhere an icon is needed; never emoji or pictograph characters. */

const dot = (cx: number, cy: number, r = 1.1) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const PATHS = {
  /* ---- modules ---- */
  dashboard: <><rect x="3.5" y="3.5" width="7" height="8" rx="2" /><rect x="13.5" y="3.5" width="7" height="5" rx="2" /><rect x="13.5" y="11.5" width="7" height="9" rx="2" /><rect x="3.5" y="14.5" width="7" height="6" rx="2" /></>,
  planner: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.75" /><path d="M8 3v4M16 3v4M3.5 10h17" />{dot(8.25, 14.25)}{dot(12, 14.25)}{dot(8.25, 17.25)}</>,
  ideas: <><path d="M9.25 17.5h5.5M10.25 20.5h3.5" /><path d="M12 3.5a6 6 0 0 0-3.55 10.84c.66.48 1.05 1.24 1.05 2.06v1.1h5v-1.1c0-.82.39-1.58 1.05-2.06A6 6 0 0 0 12 3.5Z" /><path d="M12 7.5v3M10.5 9h3" /></>,
  notes: <><path d="M6.5 3.5h8l4 4v11.25a1.75 1.75 0 0 1-1.75 1.75H6.5a1.75 1.75 0 0 1-1.75-1.75V5.25A1.75 1.75 0 0 1 6.5 3.5Z" /><path d="M14.5 3.5v4h4M8.5 12h7M8.5 15.5h4.5" /></>,
  health: <><path d="M12 19.75s-7.75-4.5-7.75-10.1A4.15 4.15 0 0 1 12 7.4a4.15 4.15 0 0 1 7.75 2.25c0 5.6-7.75 10.1-7.75 10.1Z" /><path d="M7.5 12.25h2.25l1.25-2 2 3.75 1.25-1.75h2.25" /></>,
  training: <><path d="M6.5 7.5v9M3.75 10v4M17.5 7.5v9M20.25 10v4M6.5 12h11" /></>,
  assets: <><ellipse cx="12" cy="6.5" rx="7" ry="2.75" /><path d="M5 6.5v5c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75v-5" /><path d="M5 11.5v5c0 1.52 3.13 2.75 7 2.75s7-1.23 7-2.75v-5" /></>,
  cards: <><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M6.5 14.75h3.5" /></>,
  fx: <><path d="M7 3.5v3.5M7 15v5.5M17 5v4M17 16v3.5" /><rect x="5" y="7" width="4" height="8" rx="1" /><rect x="15" y="9" width="4" height="7" rx="1" /></>,
  finance: <><path d="M4.5 8V7a2.5 2.5 0 0 1 2.5-2.5h10.5V8" /><rect x="4.5" y="8" width="15" height="11.5" rx="2.5" /><path d="M19.5 11.5h-3.25a2.25 2.25 0 0 0 0 4.5h3.25" />{dot(16.25, 13.75, 0.9)}</>,
  royalty: <><path d="M9 17.5V6.25l10-2.25v11" /><circle cx="6.75" cy="17.5" r="2.25" /><circle cx="16.75" cy="15" r="2.25" /><path d="M9 9.5l10-2.25" /></>,
  backups: <><path d="M7.25 18.5a4 4 0 0 1-.35-7.98 5.5 5.5 0 0 1 10.6-.9A4.5 4.5 0 0 1 16.75 18.5Z" /><path d="M12 16.25v-5M9.75 13.25 12 11l2.25 2.25" /></>,
  requests: <><path d="M5.25 4.75h13.5a1.75 1.75 0 0 1 1.75 1.75v8.5a1.75 1.75 0 0 1-1.75 1.75H10.5l-4.25 3.5v-3.5h-1a1.75 1.75 0 0 1-1.75-1.75V6.5a1.75 1.75 0 0 1 1.75-1.75Z" /><path d="M12 8v5.5M9.25 10.75h5.5" /></>,
  settings: <><path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h2.5M11.5 16.5H20" /><circle cx="15" cy="7.5" r="2.25" /><circle cx="9" cy="16.5" r="2.25" /></>,
  images: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.75" /><path d="m3.75 16.75 4.5-4.5a1.5 1.5 0 0 1 2.1 0l4.4 4.4M13 15l1.4-1.4a1.5 1.5 0 0 1 2.1 0l3.75 3.75" /><path d="M15.5 7.25v3.5M13.75 9h3.5" /></>,
  /* ---- shell & actions ---- */
  bell: <><path d="M6 16.75v-5.5a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" /><path d="M10 20.75a2.1 2.1 0 0 0 4 0" /></>,
  search: <><circle cx="10.75" cy="10.75" r="6.25" /><path d="m15.5 15.5 4.5 4.5" /></>,
  assistant: <><path d="M11 3.75c.55 3.95 2.55 5.95 6.5 6.5-3.95.55-5.95 2.55-6.5 6.5-.55-3.95-2.55-5.95-6.5-6.5 3.95-.55 5.95-2.55 6.5-6.5Z" /><path d="M18.25 15.75v4.5M16 18h4.5" /></>,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  "chevron-left": <path d="M14.5 5.75 8.25 12l6.25 6.25" />,
  "chevron-right": <path d="M9.5 5.75 15.75 12 9.5 18.25" />,
  "chevron-up": <path d="M5.75 14.5 12 8.25l6.25 6.25" />,
  "chevron-down": <path d="M5.75 9.5 12 15.75l6.25-6.25" />,
  "arrow-up": <path d="M12 19V5.5M6.5 11 12 5.5 17.5 11" />,
  "arrow-down": <path d="M12 5v13.5M6.5 13 12 18.5 17.5 13" />,
  "arrow-right": <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  edit: <><path d="M14.25 5.25l4.5 4.5L9 19.5H4.5V15Z" /><path d="M12 7.5l4.5 4.5" /></>,
  delete: <><path d="M4.5 7h15M9.5 7V5.25c0-.41.34-.75.75-.75h3.5c.41 0 .75.34.75.75V7" /><path d="M6.5 7l.9 11.6A2 2 0 0 0 9.4 20.5h5.2a2 2 0 0 0 2-1.9L17.5 7M10.25 11v5.5M13.75 11v5.5" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h10" />,
  more: <>{dot(5.5, 12, 1.4)}{dot(12, 12, 1.4)}{dot(18.5, 12, 1.4)}</>,
  drag: <>{dot(9, 6.5, 1.3)}{dot(15, 6.5, 1.3)}{dot(9, 12, 1.3)}{dot(15, 12, 1.3)}{dot(9, 17.5, 1.3)}{dot(15, 17.5, 1.3)}</>,
  enter: <path d="M19 5.5v6.25a3 3 0 0 1-3 3H6M9.5 11.25 6 14.75l3.5 3.5" />,
  task: <rect x="4.5" y="4.5" width="15" height="15" rx="3.75" />,
  gauge: <><path d="M4.25 16.5a7.75 7.75 0 1 1 15.5 0" /><path d="M12 16.5l3.75-4.5" />{dot(12, 16.5, 1.4)}</>,
  sun: <><circle cx="12" cy="12" r="3.75" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
  moon: <path d="M19.25 14.75A7.75 7.75 0 0 1 9.25 4.75a7.75 7.75 0 1 0 10 10Z" />,
  system: <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2.25" /><path d="M9 20h6M12 16v4" /></>,
  theme: <><circle cx="12" cy="12" r="8.25" /><path d="M12 3.75v16.5M12 8h6.75M12 12h8.25M12 16h6.75" /></>,
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.75" /><path d="M9.5 4.5v15" /></>,
  logout: <><path d="M13.5 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h6.5" /><path d="M10.5 12h9.5M16.5 8.5 20 12l-3.5 3.5" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export function Icon({ name, size = 20, strokeWidth = 1.75, className, title, ...rest }: { name: IconName; size?: number | string; strokeWidth?: number; className?: string; title?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} focusable="false" data-icon={name} {...rest}>
      {title && <title>{title}</title>}
      {PATHS[name] ?? PATHS.more}
    </svg>
  );
}

/** Icon per module key. Keyed by plain string so modules added elsewhere (e.g. "images") work before their key exists in ModuleKey. */
export const MODULE_ICONS: Partial<Record<string, IconName>> = {
  dashboard: "dashboard", planner: "planner", ideas: "ideas", notes: "notes", health: "health", training: "training", assets: "assets", cards: "cards",
  fx: "fx", finance: "finance", royalty: "royalty", backups: "backups", requests: "requests", settings: "settings", images: "images",
};
export const moduleIcon = (key: string): IconName => MODULE_ICONS[key] ?? "more";
export function ModuleIcon({ module, size, className }: { module: string; size?: number | string; className?: string }) {
  return <Icon name={moduleIcon(module)} size={size} className={className} />;
}
