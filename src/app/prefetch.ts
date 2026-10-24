// Warm route chunks before navigation. Same specifiers as App.tsx's lazy pages, so Vite resolves them to the same chunks
// and the later lazy() import is instant. Modules not listed here (e.g. ones added later) simply aren't prefetched.
const loaders: Partial<Record<string, () => Promise<unknown>>> = {
  dashboard: () => import("@/modules/dashboard/Page"),
  planner: () => import("@/modules/planner/Page"),
  ideas: () => import("@/modules/ideas/Page"),
  notes: () => import("@/modules/notes/Page"),
  health: () => import("@/modules/health/Page"),
  training: () => import("@/modules/training/Page"),
  assets: () => import("@/modules/assets/Page"),
  cards: () => import("@/modules/cards/Page"),
  fx: () => import("@/modules/fx/Page"),
  finance: () => import("@/modules/finance/Page"),
  royalty: () => import("@/modules/royalty/Page"),
  backups: () => import("@/modules/backups/Page"),
  requests: () => import("@/modules/requests/Page"),
  settings: () => import("@/modules/settings/Page"),
};
const started = new Set<string>();

export function prefetchModule(key: string) {
  if (started.has(key)) return;
  const load = loaders[key]; if (!load) return;
  started.add(key);
  load().catch(() => started.delete(key)); // let the real navigation retry
}

/** Prefetch several modules when the browser is idle (bottom tab bar targets). */
export function prefetchModules(keys: readonly string[]) {
  const run = () => keys.forEach(prefetchModule);
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1500);
}
