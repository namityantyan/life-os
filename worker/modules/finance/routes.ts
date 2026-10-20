import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, getSetting, setSetting, jstDate } from "../../core/db";
import { notify } from "../../core/notify";
import { validGmailToken } from "../cards/gmail";
import { aggregateMonthly, computeTax, computeWithholding, detectInvoiceMail, DEFAULT_MAIL_RULES, previousMonth, reconcilePdfTotal, type MailRules } from "./logic";

export const routes = new Hono<AppEnv>();

type InvoiceRow = { id: string; user_id: string; client: string; issued_on: string; amount: number; tax: number; withholding: number; pdf_total: number | null; status: string; notes: string | null; created_at: string };

const invoiceSchema = z.object({
  client: z.string().trim().min(1).max(200),
  issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().min(0),
  tax: z.number().min(0).optional(),
  withholding: z.number().min(0).optional(),
  pdf_total: z.number().nullable().optional(),
  status: z.enum(["issued", "paid"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const withReconcile = (r: InvoiceRow) => ({ ...r, reconcile: reconcilePdfTotal(r) });

routes.get("/", async (c) => {
  const user = c.get("user");
  const year = c.req.query("year");
  const rows = year
    ? await all<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE user_id=? AND issued_on LIKE ? ORDER BY issued_on DESC, created_at DESC", user.id, `${year}-%`)
    : await all<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE user_id=? ORDER BY issued_on DESC, created_at DESC LIMIT 500", user.id);
  return c.json({ invoices: rows.map(withReconcile) });
});

routes.get("/summary", async (c) => {
  const user = c.get("user");
  const year = Number(c.req.query("year") ?? jstDate().slice(0, 4));
  const rows = await all<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE user_id=? AND issued_on LIKE ? ORDER BY issued_on", user.id, `${year}-%`);
  const months = aggregateMonthly(rows, year);
  const mismatches = rows.map(withReconcile).filter((r) => r.reconcile.status === "mismatch");
  const years = await all<{ y: string }>(c.env.DB, "SELECT DISTINCT substr(issued_on,1,4) AS y FROM invoices WHERE user_id=? ORDER BY y DESC", user.id);
  const totals = months.reduce((a, m) => ({ count: a.count + m.count, amount: a.amount + m.amount, tax: a.tax + m.tax, withholding: a.withholding + m.withholding, total: a.total + m.total }), { count: 0, amount: 0, tax: 0, withholding: 0, total: 0 });
  return c.json({ year, months, totals, mismatches, years: years.map((r) => Number(r.y)) });
});

routes.post("/", async (c) => {
  const user = c.get("user");
  const b = invoiceSchema.parse(await c.req.json());
  const tax = b.tax ?? computeTax(b.amount);
  const withholding = b.withholding ?? computeWithholding(b.amount);
  const id = newId();
  await run(c.env.DB, "INSERT INTO invoices (id,user_id,client,issued_on,amount,tax,withholding,pdf_total,status,notes) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id, user.id, b.client, b.issued_on, b.amount, tax, withholding, b.pdf_total ?? null, b.status ?? "issued", b.notes ?? null);
  const row = await one<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE id=?", id);
  return c.json(withReconcile(row!), 201);
});

routes.put("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const cur = await one<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE id=? AND user_id=?", id, user.id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = invoiceSchema.partial().parse(await c.req.json());
  const amount = b.amount ?? cur.amount;
  const next = {
    client: b.client ?? cur.client, issued_on: b.issued_on ?? cur.issued_on, amount,
    tax: b.tax ?? (b.amount != null ? computeTax(amount) : cur.tax),
    withholding: b.withholding ?? (b.amount != null ? computeWithholding(amount) : cur.withholding),
    pdf_total: b.pdf_total === undefined ? cur.pdf_total : b.pdf_total,
    status: b.status ?? cur.status, notes: b.notes === undefined ? cur.notes : b.notes,
  };
  await run(c.env.DB, "UPDATE invoices SET client=?,issued_on=?,amount=?,tax=?,withholding=?,pdf_total=?,status=?,notes=? WHERE id=?",
    next.client, next.issued_on, next.amount, next.tax, next.withholding, next.pdf_total, next.status, next.notes, id);
  const row = await one<InvoiceRow>(c.env.DB, "SELECT * FROM invoices WHERE id=?", id);
  return c.json(withReconcile(row!));
});

routes.delete("/:id", async (c) => {
  const user = c.get("user");
  await run(c.env.DB, "DELETE FROM invoices WHERE id=? AND user_id=?", c.req.param("id"), user.id);
  return c.json({ ok: true });
});

// ---- Mail detection rules ----
const rulesSchema = z.object({ include: z.array(z.string().max(100)).max(50), exclude: z.array(z.string().max(100)).max(50), senders: z.array(z.string().max(200)).max(50) });

routes.get("/mail-rules", async (c) => {
  const user = c.get("user");
  const rules = await getSetting<MailRules>(c.env, user.id, "invoice_mail_rules", DEFAULT_MAIL_RULES);
  return c.json({ rules, defaults: DEFAULT_MAIL_RULES });
});
routes.put("/mail-rules", async (c) => {
  const user = c.get("user");
  const rules = rulesSchema.parse(await c.req.json());
  const clean = { include: rules.include.map((s) => s.trim()).filter(Boolean), exclude: rules.exclude.map((s) => s.trim()).filter(Boolean), senders: rules.senders.map((s) => s.trim()).filter(Boolean) };
  await setSetting(c.env, user.id, "invoice_mail_rules", clean);
  return c.json({ rules: clean });
});
/** Dry-run the rules on a subject/sender (used by the rules editor). */
routes.post("/mail-rules/test", async (c) => {
  const user = c.get("user");
  const b = z.object({ subject: z.string().max(500), from: z.string().max(300).optional() }).parse(await c.req.json());
  const rules = await getSetting<MailRules>(c.env, user.id, "invoice_mail_rules", DEFAULT_MAIL_RULES);
  return c.json(detectInvoiceMail(b.subject, b.from ?? "", rules));
});

// ---- Gmail scan (requires an OAuth token stored by the settings/Gmail integration) ----
type GmailToken = { access_token: string; expires_at?: string };
export async function gmailToken(env: Env, userId: string): Promise<GmailToken | null> {
  // Encrypted token written by 設定 → 接続; refreshed on expiry by the cards module helper.
  try { const t = await validGmailToken(env, userId); return t?.access_token ? { access_token: t.access_token, expires_at: typeof t.expires_at === "string" ? t.expires_at : undefined } : null; }
  catch { return null; }
}
export type GmailMessage = { id: string; subject: string; from: string; date: string; snippet: string };
export async function gmailSearch(token: string, query: string, max = 30): Promise<GmailMessage[]> {
  const h = { Authorization: `Bearer ${token}` };
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`, { headers: h });
  if (!list.ok) throw new Error(`gmail list ${list.status}`);
  const { messages = [] } = (await list.json()) as { messages?: { id: string }[] };
  const out: GmailMessage[] = [];
  for (const m of messages) {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers: h });
    if (!r.ok) continue;
    const j = (await r.json()) as { id: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
    const hd = (n: string) => j.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    out.push({ id: j.id, subject: hd("subject"), from: hd("from"), date: hd("date"), snippet: j.snippet ?? "" });
  }
  return out;
}

routes.post("/gmail/scan", async (c) => {
  const user = c.get("user");
  const tok = await gmailToken(c.env, user.id);
  if (!tok) return c.json({ connected: false, hits: [] });
  const rules = await getSetting<MailRules>(c.env, user.id, "invoice_mail_rules", DEFAULT_MAIL_RULES);
  const q = rules.include.map((k) => `subject:"${k.replace(/"/g, "")}"`).join(" OR ") + " newer_than:60d";
  const msgs = await gmailSearch(tok.access_token, q);
  const hits = msgs.map((m) => ({ ...m, detection: detectInvoiceMail(m.subject, m.from, rules) })).filter((m) => m.detection.match);
  for (const h of hits) {
    await notify(c.env, user.id, { kind: "invoice", title: h.detection.kind === "receipt" ? "領収書メールを検知" : "請求書メールを検知", body: h.subject, url: "/finance", dedupeKey: `invoice-mail:${h.id}` });
  }
  return c.json({ connected: true, scanned: msgs.length, hits });
});

/** Daily cron (07:00 JST): on the 1st–3rd of each month, remind once about the previous month's withholding. */
export async function monthlyWithholdingReminder(env: Env, userId: string) {
  const today = jstDate();
  const day = Number(today.slice(8, 10));
  if (day < 1 || day > 3) return;
  const month = previousMonth(today);
  const rows = await all<{ amount: number; tax: number; withholding: number; pdf_total: number | null; issued_on: string }>(env.DB,
    "SELECT amount,tax,withholding,pdf_total,issued_on FROM invoices WHERE user_id=? AND issued_on LIKE ?", userId, `${month}-%`);
  const [y, m] = month.split("-");
  const sum = rows.reduce((a, r) => a + r.withholding, 0);
  const body = rows.length === 0
    ? `${y}年${Number(m)}月に記録した請求書はありません。`
    : `${y}年${Number(m)}月の請求書 ${rows.length}件、源泉徴収合計 ${Math.round(sum).toLocaleString("ja-JP")}円。納付・記帳の確認をしてください。`;
  await notify(env, userId, { kind: "withholding", title: "前月分の源泉徴収の確認", body, url: "/finance", dedupeKey: `withholding:${month}` });
}
