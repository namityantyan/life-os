export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  AI?: Ai;
  ASSETS: Fetcher;
  APP_NAME: string;
  APP_ORIGIN: string;
  ALLOWED_EMAILS: string;
  DEV_LOGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Discord bot is off unless "1": the interactions endpoint and /api/discord/* answer 404. */
  DISCORD_ENABLED?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  OURA_ACCESS_TOKEN?: string;
  OURA_CLIENT_ID?: string;
  OURA_CLIENT_SECRET?: string;
  OURA_REFRESH_TOKEN_SEED?: string;
  FREEE_CLIENT_ID?: string;
  FREEE_CLIENT_SECRET?: string;
  BACKUP_INGEST_TOKEN?: string;
  FX_CONNECTOR_TOKEN?: string;
  /** FX hub (self-hosted Node process on the VPS). When FX_HUB_URL is set, the Worker proxies /api/fx/* and
   *  /api/integrations/fx/* there, so high-frequency FX writes never touch D1/KV free-tier limits. */
  FX_HUB_URL?: string;          // e.g. https://fx.example.net (Worker → hub)
  FX_HUB_PUBLIC_URL?: string;   // URL written into the connector ini (connector → hub); defaults to FX_HUB_URL
  FX_HUB_SECRET?: string;       // shared secret between Worker and hub
  /** Self-hosting (server/): the Node server sets GOOGLE_REDIRECT_ORIGIN and AI_RELAY_*; the Cloudflare
   *  Worker sets SELF_HOSTED_ORIGIN and then only bounces OAuth callbacks, relays Workers AI and forwards. */
  SELF_HOSTED_ORIGIN?: string;
  GOOGLE_REDIRECT_ORIGIN?: string;
  AI_RELAY_URL?: string;
  AI_RELAY_SECRET?: string;
  MIGRATION_EXPORT_UNTIL?: string;
  /* Set only inside the hub process: */
  IS_FX_HUB?: string;
  FX_HUB_OWNER_ID?: string;     // Life OS user id that owns the FX data
  FX_HUB_NOTIFY_URL?: string;   // Worker endpoint the hub posts trade notifications to
};

export type Variables = { user: import("../shared/types").User };
export type AppEnv = { Bindings: Env; Variables: Variables };
