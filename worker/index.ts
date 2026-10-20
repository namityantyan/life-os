import { Hono } from "hono";
import type { AppEnv, Env } from "./env";
import { authRoutes, requireAuth } from "./core/auth";
import { coreRoutes } from "./core/routes";
import { runScheduled } from "./cron";
import { registerModules, registerPublicModules } from "./modules";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  const status = (err as any)?.name === "ZodError" ? 400 : 500;
  return c.json({ error: status === 400 ? "invalid input" : "internal error", detail: String(err?.message ?? err) }, status);
});

app.get("/api/health", (c) => c.json({ ok: true, app: c.env.APP_NAME, time: new Date().toISOString() }));
app.route("/api/auth", authRoutes);

// Public integration endpoints authenticate with their own tokens (backup PC, FX connector, Discord).
registerPublicModules(app);

const authed = new Hono<AppEnv>();
authed.use("*", requireAuth);
authed.route("/", coreRoutes);
registerModules(authed);
app.route("/api", authed);

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env, event.cron));
  },
} satisfies ExportedHandler<Env>;
