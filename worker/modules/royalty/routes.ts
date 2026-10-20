import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId } from "../../core/db";
import { notify } from "../../core/notify";
import { gmailSearch, gmailToken } from "../finance/routes";
import { classifyRoyaltyMail, extractTargetMonth, PROVIDERS, PROVIDER_LABELS, PROVIDER_PORTALS, type Provider } from "./logic";

export const routes = new Hono<AppEnv>();

type MailRow = { id: string; user_id: string; provider: Provider; subject: string; sender: string | null; received_at: string; target_month: string | null; status: "target" | "review" | "excluded"; processed: number; external_id: string | null; link: string | null; created_at: string };

const decorate = (r: MailRow) => ({ ...r, processed: Boolean(r.processed), provider_label: PROVIDER_LABELS[r.provider] ?? r.provider, portal: r.link ?? PROVIDER_PORTALS[r.provider] ?? null });

routes.get("/", async (c) => {
  const user = c.get("user");
  const q = c.req.query();
  const where: string[] = ["user_id=?"]; const params: unknown[] = [user.id];
  if (q.provider && (PROVIDERS as readonly string[]).includes(q.provider)) { where.push("provider=?"); params.push(q.provider); }
  if (q.status && ["target", "review", "excluded"].includes(q.status)) { where.push("status=?"); params.push(q.status); }
  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) { where.push("target_month=?"); params.push(q.month); }
  if (q.processed === "0" || q.processed === "1") { where.push("processed=?"); params.push(Number(q.processed)); }
  const rows = await all<MailRow>(c.env.DB, `SELECT * FROM royalty_mails WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT 300`, ...params);
  return c.json({ mails: rows.map(decorate), providers: PROVIDERS.map((p) => ({ key: p, label: PROVIDER_LABELS[p] })) });
});

routes.get("/summary", async (c) => {
  const user = c.get("user");
  const byProvider = await all<{ provider: Provider; status: string; n: number }>(c.env.DB, "SELECT provider,status,COUNT(*) AS n FROM royalty_mails WHERE user_id=? GROUP BY provider,status", user.id);
  const byMonth = await all<{ target_month: string | null; n: number; unprocessed: number }>(c.env.DB, "SELECT target_month, COUNT(*) AS n, SUM(CASE WHEN processed=0 AND status='target' THEN 1 ELSE 0 END) AS unprocessed FROM royalty_mails WHERE user_id=? GROUP BY target_month ORDER BY target_month DESC LIMIT 24", user.id);
  const months = await all<{ m: string }>(c.env.DB, "SELECT DISTINCT target_month AS m FROM royalty_mails WHERE user_id=? AND target_month IS NOT NULL ORDER BY m DESC", user.id);
  const pending = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM royalty_mails WHERE user_id=? AND status='target' AND processed=0", user.id);
  return c.json({ byProvider, byMonth, months: months.map((r) => r.m), pending_target: pending?.n ?? 0 });
});

const manualSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  sender: z.string().trim().max(300).optional(),
  body: z.string().max(20000).optional(),
  received_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "日時の形式が不正です").optional(),
  link: z.string().url().nullable().optional(),
});
/** Register a mail by hand (testing / mails that never reached Gmail sync). Classified by the same rules as the Gmail sync. */
routes.post("/manual", async (c) => {
  const user = c.get("user");
  const b = manualSchema.parse(await c.req.json());
  const cls = classifyRoyaltyMail({ from: b.sender, subject: b.subject, body: b.body });
  const id = newId();
  await run(c.env.DB, "INSERT INTO royalty_mails (id,user_id,provider,subject,sender,received_at,target_month,status,processed,external_id,link) VALUES (?,?,?,?,?,?,?,?,0,NULL,?)",
    id, user.id, cls.provider, b.subject, b.sender ?? null, b.received_at ? new Date(b.received_at).toISOString() : new Date().toISOString(), extractTargetMonth(b.subject, b.body), cls.status, b.link ?? null);
  const row = await one<MailRow>(c.env.DB, "SELECT * FROM royalty_mails WHERE id=?", id);
  return c.json({ ...decorate(row!), reason: cls.reason }, 201);
});

routes.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const b = z.object({ status: z.enum(["target", "review", "excluded"]).optional(), processed: z.boolean().optional(), target_month: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(), provider: z.enum(PROVIDERS).optional() }).parse(await c.req.json());
  const cur = await one<MailRow>(c.env.DB, "SELECT * FROM royalty_mails WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE royalty_mails SET status=?, processed=?, target_month=?, provider=? WHERE id=?",
    b.status ?? cur.status, b.processed == null ? cur.processed : (b.processed ? 1 : 0), b.target_month === undefined ? cur.target_month : b.target_month, b.provider ?? cur.provider, id);
  const row = await one<MailRow>(c.env.DB, "SELECT * FROM royalty_mails WHERE id=?", id);
  return c.json(decorate(row!));
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM royalty_mails WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});

/** Pull candidate mails from Gmail (if the Gmail integration token exists), classify, and store new ones. */
routes.post("/gmail/sync", async (c) => {
  const user = c.get("user");
  const tok = await gmailToken(c.env, user.id);
  if (!tok) return c.json({ connected: false, added: 0 });
  const q = "(nextone OR nex-tone OR d-coret OR dcoret OR mcjp OR rights.services OR ponycanyon OR basemint OR 分配明細 OR 支払明細) newer_than:90d";
  const msgs = await gmailSearch(tok.access_token, q, 50);
  let added = 0;
  for (const m of msgs) {
    const dup = await one(c.env.DB, "SELECT 1 FROM royalty_mails WHERE user_id=? AND external_id=?", user.id, m.id);
    if (dup) continue;
    const cls = classifyRoyaltyMail({ from: m.from, subject: m.subject, body: m.snippet });
    const received = m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(m.date).toISOString() : new Date().toISOString();
    await run(c.env.DB, "INSERT INTO royalty_mails (id,user_id,provider,subject,sender,received_at,target_month,status,processed,external_id,link) VALUES (?,?,?,?,?,?,?,?,0,?,NULL)",
      newId(), user.id, cls.provider, m.subject || "(件名なし)", m.from || null, received, extractTargetMonth(m.subject, m.snippet), cls.status, m.id);
    added++;
    if (cls.status === "target") await notify(c.env, user.id, { kind: "royalty", title: `${PROVIDER_LABELS[cls.provider]}の明細通知`, body: m.subject, url: "/royalty", dedupeKey: `royalty-mail:${m.id}` });
  }
  return c.json({ connected: true, scanned: msgs.length, added });
});
