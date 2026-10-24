import { cacheClear, cacheEpoch, cacheGet, cacheHas, cacheSet, cacheSetIfCurrent, invalidateFor } from "./apiCache";
export class ApiError extends Error { constructor(public status: number, message: string, public detail?: unknown) { super(message); } }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== "GET") { try { return await send<T>(method, path, body); } finally { invalidateFor(path); } }
  return send<T>(method, path, body);
}
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) { cacheClear(); window.dispatchEvent(new CustomEvent("lifeos:unauthorized")); throw new ApiError(401, "unauthorized"); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.detail);
  return data as T;
}
export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
/**
 * Small data hook with loading/error/reload and optional polling (ms). Responses are kept in a
 * module-level cache (./apiCache): a revisit renders the cached data immediately (loading=false)
 * and revalidates silently. `quiet` also keeps path changes silent while earlier data is shown.
 */
export function useApi<T>(path: string | null, opts: { poll?: number; deps?: unknown[]; quiet?: boolean } = {}) {
  const [data, setDataState] = useState<T | null>(() => (path ? cacheGet<T>(path) ?? null : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(path) && !(path && cacheHas(path)));
  const alive = useRef(true);
  const shown = useRef(data != null); shown.current = data != null;
  const reload = useCallback(async (silent = false) => {
    if (!path) return;
    if (!silent) setLoading(true);
    const at = cacheEpoch();
    try {
      const d = await api.get<T>(path); cacheSetIfCurrent(path, d, at);
      // A mutation landed while this GET was in flight: its answer is older than what the screen shows
      // (optimistic updates), so keep the screen unless there is nothing to show yet.
      if (alive.current && (at === cacheEpoch() || !shown.current)) { setDataState(d); setError(null); }
    }
    catch (e: any) { if (alive.current) setError(e?.message ?? String(e)); }
    finally { if (alive.current) setLoading(false); }
  }, [path]);
  const setData = useCallback((v: SetStateAction<T | null>) => setDataState((prev) => {
    const next = typeof v === "function" ? (v as (p: T | null) => T | null)(prev) : v;
    if (path && next != null) cacheSet(path, next);
    return next;
  }), [path]);
  useEffect(() => {
    alive.current = true;
    const hit = path ? cacheHas(path) : false;
    if (hit) { setDataState(cacheGet<T>(path!) ?? null); setLoading(false); }
    reload(hit || (Boolean(opts.quiet) && shown.current));
    return () => { alive.current = false; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...(opts.deps ?? [])]);
  useEffect(() => {
    if (!opts.poll || !path) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") reload(true); }, opts.poll);
    return () => clearInterval(id);
  }, [opts.poll, path, reload]);
  return { data, error, loading, reload, setData };
}

export const fmtYen = (n: number | null | undefined, opts: { sign?: boolean } = {}) => n == null ? "—" : `${opts.sign && n > 0 ? "+" : ""}${Math.round(n).toLocaleString("ja-JP")}円`;
export const fmtNum = (n: number | null | undefined, digits = 0) => n == null ? "—" : n.toLocaleString("ja-JP", { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const fmtDate = (iso: string | null | undefined) => { if (!iso) return "—"; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
export const fmtDateTime = (iso: string | null | undefined) => { if (!iso) return "—"; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
export const todayJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
