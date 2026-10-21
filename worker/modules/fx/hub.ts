import type { Context } from "hono";
import type { AppEnv, Env } from "../../env";
import { all, one } from "../../core/db";

/** True in the Cloudflare Worker when FX is delegated to the self-hosted hub. */
export const hubEnabled = (env: Env) => Boolean(env.FX_HUB_URL && env.FX_HUB_SECRET && env.IS_FX_HUB !== "1");

/** Forward the current request to the hub, keeping method, path, query, body and the connector's Authorization. */
export async function proxyToHub(c: Context<AppEnv>, userId: string | null): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const headers = new Headers();
  const ct = c.req.header("Content-Type"); if (ct) headers.set("Content-Type", ct);
  const auth = c.req.header("Authorization"); if (auth) headers.set("Authorization", auth);
  headers.set("X-Hub-Secret", env.FX_HUB_SECRET!);
  if (userId) headers.set("X-Lifeos-User", userId);
  const method = c.req.method;
  try {
    const res = await fetch(env.FX_HUB_URL!.replace(/\/$/, "") + url.pathname + url.search, {
      method, headers, body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(), signal: AbortSignal.timeout(10_000),
    });
    const out = new Headers({ "Cache-Control": "no-store" });
    for (const h of ["Content-Type", "Content-Disposition"]) { const v = res.headers.get(h); if (v) out.set(h, v); }
    return new Response(res.body, { status: res.status, headers: out });
  } catch (e) {
    return c.json({ error: "FXハブに接続できません", detail: String(e) }, 502);
  }
}

async function hubGet<T>(env: Env, userId: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(env.FX_HUB_URL!.replace(/\/$/, "") + path, { headers: { "X-Hub-Secret": env.FX_HUB_SECRET!, "X-Lifeos-User": userId }, signal: AbortSignal.timeout(2500) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch { return null; }
}

/** FX summary for the Life Context (open positions, connector online). Never throws. */
export async function fxSummary(env: Env, userId: string): Promise<{ open_positions: number; connector_online: boolean }> {
  if (hubEnabled(env)) {
    const s = await hubGet<{ open_positions: number; connector_online: boolean }>(env, userId, "/api/fx/status");
    return { open_positions: s?.open_positions ?? 0, connector_online: Boolean(s?.connector_online) };
  }
  const [state, openPos] = await Promise.all([
    one<{ received_at: string }>(env.DB, "SELECT received_at FROM fx_connector_state WHERE user_id=?", userId),
    one<{ n: number }>(env.DB, "SELECT COUNT(*) n FROM fx_trades WHERE user_id=? AND status='open'", userId),
  ]);
  return { open_positions: openPos?.n ?? 0, connector_online: Boolean(state?.received_at && Date.now() - new Date(state.received_at).getTime() < 45_000) };
}

/** Latest quotes for the dashboard card. Never throws. */
export async function fxQuotes(env: Env, userId: string): Promise<{ pair: string; bid: number; ask: number; quoted_at: string }[]> {
  if (hubEnabled(env)) {
    const p = await hubGet<{ pairs: { pair: string; quote: { bid: number; ask: number; at: string } | null }[] }>(env, userId, "/api/fx/pairs");
    return (p?.pairs ?? []).filter((x) => x.quote).map((x) => ({ pair: x.pair, bid: x.quote!.bid, ask: x.quote!.ask, quoted_at: x.quote!.at }));
  }
  return all(env.DB, "SELECT pair,bid,ask,quoted_at FROM fx_quotes ORDER BY pair");
}
