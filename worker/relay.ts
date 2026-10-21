// Cloudflare Worker in "relay" mode, deployed with wrangler.relay.jsonc after Life OS moved to the VPS.
//  - Google OAuth callbacks registered at this workers.dev origin bounce the browser (code/state untouched)
//    to the self-hosted server, which exchanges the code with the same redirect_uri.
//  - /api/integrations/* (Windows connector, backup PC, Discord) is proxied so older configs keep working.
//  - POST /api/internal/ai runs Workers AI for the server (free tier, no API token needed).
//  - Everything else redirects to the self-hosted origin. No cron, no storage.
import type { Env } from "./env";
import { migrateSecrets, safeEqual } from "./selfhost-bridge";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function proxy(req: Request, target: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("Host");
  try {
    const res = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual", signal: AbortSignal.timeout(20_000) });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e) {
    return json({ error: "self-hosted server unreachable", detail: String(e) }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const self = (env.SELF_HOSTED_ORIGIN ?? "").replace(/\/$/, "");
    const url = new URL(req.url);
    const p = url.pathname;
    const exported = migrateSecrets(req, env);
    if (exported) return exported;

    if (p === "/api/internal/ai" && req.method === "POST") {
      if (!env.AI_RELAY_SECRET || !safeEqual(req.headers.get("X-Relay-Secret") ?? "", env.AI_RELAY_SECRET)) return json({ error: "unauthorized" }, 401);
      if (!env.AI) return json({ error: "AI binding missing" }, 503);
      const { model, input } = (await req.json()) as { model: string; input: Record<string, unknown> };
      // Workers limit a request to 30 s of CPU but allow long waits on a binding; give the model room.
      try { return json(await env.AI.run(model as never, input as never)); }
      catch (e) { return json({ error: "ai failed", detail: String(e) }, 502); }
    }
    if (!self) return json({ error: "SELF_HOSTED_ORIGIN is not set" }, 503);
    if (p === "/api/auth/google/callback" || p === "/api/integrations/google/callback") {
      return Response.redirect(self + p + url.search, 302);
    }
    if (p.startsWith("/api/integrations/") || p === "/api/health") return proxy(req, self + p + url.search);
    return Response.redirect(self + p + url.search, req.method === "GET" || req.method === "HEAD" ? 301 : 308);
  },
  async scheduled() { /* cron runs on the self-hosted server */ },
} satisfies ExportedHandler<Env>;
