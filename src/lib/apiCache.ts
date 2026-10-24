// Module-level stale-while-revalidate cache for useApi (GET responses keyed by path).
// A revisited page renders the last response at once and refreshes it silently.
// Mutations (POST/PUT/PATCH/DELETE) drop every entry of the same module (first path segment) plus
// /dashboard, which aggregates all modules; /auth mutations and a 401 clear everything (user switch).

const MAX = 120;
const store = new Map<string, unknown>();
let epoch = 0;

/** "/fx/chart?pair=x" → "fx" */
export const moduleOf = (path: string) => path.split("?")[0].split("/").filter(Boolean)[0] ?? "";
export const cacheHas = (path: string) => store.has(path);
export const cacheGet = <T>(path: string): T | undefined => store.get(path) as T | undefined;
export function cacheSet(path: string, data: unknown) {
  store.delete(path); store.set(path, data); // re-insert = most recent
  while (store.size > MAX) store.delete(store.keys().next().value as string);
}
/** Epoch before a GET; `cacheSetIfCurrent` skips the write when a mutation landed meanwhile (stale read). */
export const cacheEpoch = () => epoch;
export function cacheSetIfCurrent(path: string, data: unknown, startedAt: number) { if (startedAt === epoch) cacheSet(path, data); }
export function invalidateFor(path: string) {
  epoch++;
  const mod = moduleOf(path);
  if (mod === "auth") { store.clear(); return; }
  for (const k of [...store.keys()]) { const m = moduleOf(k); if (m === mod || m === "dashboard") store.delete(k); }
}
export function cacheClear() { epoch++; store.clear(); }
