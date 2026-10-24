import type { Hono } from "hono";
import type { AppEnv } from "../env";

/**
 * Module registry. Each module exposes `routes` (authenticated, mounted under /api/<name>)
 * and optionally `publicRoutes` (token-authenticated integrations, mounted under /api/integrations/<name>).
 * Modules are added here as they are implemented.
 */
import * as planner from "./planner/routes";
import * as ideas from "./ideas/routes";
import * as notes from "./notes/routes";
import * as health from "./health/routes";
import * as training from "./training/routes";
import * as assets from "./assets/routes";
import * as cards from "./cards/routes";
import * as fx from "./fx/routes";
import * as finance from "./finance/routes";
import * as royalty from "./royalty/routes";
import * as backups from "./backups/routes";
import * as requests from "./requests/routes";
import * as discord from "./discord/routes";
import * as dashboard from "./dashboard/routes";
import * as integrations from "./integrations/routes";
import * as data from "./data/routes";
import * as fxhub from "./fxhub/routes";
import * as assistant from "./assistant/routes";
import * as images from "./images/routes";

type Mod = { routes?: Hono<AppEnv>; publicRoutes?: Hono<AppEnv> };
const modules: Record<string, Mod> = { planner, ideas, notes, health, training, assets, cards, fx, finance, royalty, backups, requests, discord, dashboard, integrations, data, assistant, images, fxhub };

export function registerModules(app: Hono<AppEnv>) {
  for (const [name, m] of Object.entries(modules)) if (m.routes) app.route(`/${name}`, m.routes);
}
export function registerPublicModules(app: Hono<AppEnv>) {
  for (const [name, m] of Object.entries(modules)) if (m.publicRoutes) app.route(`/api/integrations/${name}`, m.publicRoutes);
}
