import { Hono } from "hono";
import type { AppEnv } from "../../env";
export const routes = new Hono<AppEnv>();
routes.get("/", (c) => c.json({ module: "data", status: "stub" }));
