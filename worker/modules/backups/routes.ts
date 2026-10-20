import { Hono } from "hono";
import type { AppEnv } from "../../env";
export const routes = new Hono<AppEnv>();
routes.get("/", (c) => c.json({ module: "backups", status: "stub" }));
import type { Env } from "../../env";
export async function checkBackupStaleness(_env: Env, _userId: string) { /* implemented by backups module */ }
