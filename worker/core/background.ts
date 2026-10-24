/** Runs work after the response: Workers `waitUntil`, or (no execution context: tests, cron callers) just lets it run. */
export type Background = (p: Promise<unknown>) => void;
export const detach: Background = (p) => { p.catch((e) => console.warn("background task failed", String(e))); };
export const backgroundOf = (c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): Background => (p) => {
  const q = p.catch((e) => console.warn("background task failed", String(e)));
  try { c.executionCtx.waitUntil(q); } catch { /* no execution context → q still runs */ }
};
