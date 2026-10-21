import type { Env } from "./env";

/** Constant-time string compare. */
export const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

/**
 * One-time hand-over of Worker secrets to the self-hosted server (Cloudflare secrets are write-only).
 * Enabled only while the secret MIGRATION_EXPORT_UNTIL (epoch ms) is in the future and the caller
 * presents FX_HUB_SECRET. Remove MIGRATION_EXPORT_UNTIL right after use.
 */
export function migrateSecrets(req: Request, env: Env): Response | null {
  const url = new URL(req.url);
  if (url.pathname !== "/api/internal/migrate-secrets" || req.method !== "POST") return null;
  const until = Number(env.MIGRATION_EXPORT_UNTIL ?? 0);
  if (!until || Date.now() > until || !env.FX_HUB_SECRET || !safeEqual(req.headers.get("X-Hub-Secret") ?? "", env.FX_HUB_SECRET)) {
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  const keys = ["SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "DISCORD_PUBLIC_KEY", "DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "OURA_ACCESS_TOKEN", "OURA_CLIENT_ID", "OURA_CLIENT_SECRET",
    "FREEE_CLIENT_ID", "FREEE_CLIENT_SECRET", "BACKUP_INGEST_TOKEN", "FX_CONNECTOR_TOKEN", "ALLOWED_EMAILS"] as const;
  const out: Record<string, string> = {};
  for (const k of keys) { const v = (env as Record<string, unknown>)[k]; if (typeof v === "string" && v) out[k] = v; }
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
