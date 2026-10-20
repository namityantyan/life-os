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
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  OURA_ACCESS_TOKEN?: string;
  FREEE_CLIENT_ID?: string;
  FREEE_CLIENT_SECRET?: string;
  BACKUP_INGEST_TOKEN?: string;
  FX_CONNECTOR_TOKEN?: string;
};

export type Variables = { user: import("../shared/types").User };
export type AppEnv = { Bindings: Env; Variables: Variables };
