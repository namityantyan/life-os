import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { notify } from "../../core/notify";
import { NOTIFICATION_KINDS } from "../../../shared/types";

/** Receives trade notifications from the self-hosted FX hub (POST /api/integrations/fxhub/notify). */
export const publicRoutes = new Hono<AppEnv>();

const bodyZ = z.object({
  userId: z.string().min(1).max(64),
  kind: z.enum(NOTIFICATION_KINDS),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  url: z.string().max(300).optional(),
  dedupeKey: z.string().max(300).optional(),
});

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

publicRoutes.post("/notify", async (c) => {
  const secret = c.env.FX_HUB_SECRET;
  if (!secret || !timingSafeEqual(c.req.header("X-Hub-Secret") ?? "", secret)) return c.json({ error: "unauthorized" }, 401);
  const n = bodyZ.parse(await c.req.json());
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE id=?").bind(n.userId).first();
  if (!exists) return c.json({ error: "unknown user" }, 404);
  const id = await notify(c.env, n.userId, { kind: n.kind, title: n.title, body: n.body, url: n.url, dedupeKey: n.dedupeKey });
  return c.json({ ok: true, id, duplicate: id === null });
});
