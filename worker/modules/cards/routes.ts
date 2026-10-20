import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId, getSetting, setSetting, jstDate } from "../../core/db";
import { adviseWithContext } from "../../core/context";
import type { CardTransaction, CardStatement, CardSettings, CardOverview } from "@shared/cards";
import type { AssetAccount } from "@shared/assets";
import { monthTotal, budgetLeft, cumulativeSeries, extraSpendGuide, parseStatementCsv, aggregateByMerchant } from "./logic";
import { freshPersonalCash } from "../assets/logic";
import { syncGmail } from "./gmail";
import { loadToken } from "../assets/freee";

export const routes = new Hono<AppEnv>();
const uid = (c: any) => c.get("user").id as string;
const DEFAULT_SETTINGS: CardSettings = { monthly_budget: null, reserve_cash: null, unpaid_confirmed: null, next_bonus_date: null };
const settingsSchema = z.object({ monthly_budget: z.number().nullable().default(null), reserve_cash: z.number().nullable().default(null), unpaid_confirmed: z.number().nullable().default(null), next_bonus_date: z.string().nullable().default(null) });

async function personalCash(env: AppEnv["Bindings"], userId: string, today: string) {
  const rows = await all<AssetAccount & { recorded_on: string | null; jpy_value: number | null }>(env.DB,
    `SELECT a.*, b.recorded_on, b.jpy_value FROM asset_accounts a
     LEFT JOIN asset_balances b ON b.id = (SELECT id FROM asset_balances WHERE account_id=a.id ORDER BY recorded_on DESC, created_at DESC LIMIT 1)
     WHERE a.user_id=? AND a.archived_at IS NULL AND a.owner_type='personal' AND a.category='bank' AND a.currency='JPY'`, userId);
  const withBal = rows.filter((r) => r.recorded_on).map((r) => ({ account: r, recorded_on: r.recorded_on!, jpy_value: r.jpy_value }));
  const latestAny = rows.map((r) => r.recorded_on).filter(Boolean).sort().at(-1) ?? null;
  const c = freshPersonalCash(withBal, today);
  return { amount: c.amount, fresh: c.amount != null, as_of: c.as_of ?? latestAny, reason: c.reason };
}

async function buildOverview(env: AppEnv["Bindings"], userId: string): Promise<CardOverview> {
  const today = jstDate(); const month = today.slice(0, 7);
  const [txs, settings, statements, cash, gmail] = await Promise.all([
    all<CardTransaction>(env.DB, "SELECT * FROM card_transactions WHERE user_id=? ORDER BY used_at, created_at", userId),
    getSetting<CardSettings>(env, userId, "card_settings", DEFAULT_SETTINGS),
    all<CardStatement>(env.DB, "SELECT * FROM card_statements WHERE user_id=? ORDER BY billing_month DESC", userId),
    personalCash(env, userId, today),
    loadToken(env, userId, "gmail"),
  ]);
  const total = monthTotal(txs, month);
  const left = budgetLeft(settings.monthly_budget, total);
  const paidIds = new Set(statements.filter((s) => s.paid).map((s) => s.id));
  const notifiedUnpaid = txs.filter((t) => t.status !== "cancelled" && !(t.statement_id && paidIds.has(t.statement_id))).reduce((s, t) => s + t.amount, 0);
  const unpaidStatements = statements.filter((s) => !s.paid).sort((a, b) => (a.debit_date ?? "9999").localeCompare(b.debit_date ?? "9999"));
  const statement = unpaidStatements.find((s) => (s.debit_date ?? "9999") >= today) ?? unpaidStatements[0] ?? null;
  let running = 0;
  const timeline = txs.filter((t) => t.used_at.slice(0, 7) === month).map((t) => ({ ...t, running: (running += t.status === "cancelled" ? 0 : t.amount) })).reverse();
  const guide = extraSpendGuide({ cash: cash.amount, cashFresh: cash.fresh, reserve: settings.reserve_cash, unpaidConfirmed: settings.unpaid_confirmed, notifiedTotal: notifiedUnpaid, budgetLeft: left, nextBonusDate: settings.next_bonus_date, today });
  if (guide.undetermined && cash.amount == null && cash.reason) guide.reason = cash.reason;
  return { month, today, month_total: total, count: txs.filter((t) => t.status !== "cancelled" && t.used_at.slice(0, 7) === month).length, budget: settings.monthly_budget, budget_left: left,
    series: cumulativeSeries(txs, month, today), timeline, statement, notified_unpaid: notifiedUnpaid, cash: { amount: cash.amount, fresh: cash.fresh, as_of: cash.as_of }, guide, gmail_connected: Boolean(gmail) };
}
routes.get("/overview", async (c) => c.json(await buildOverview(c.env, uid(c))));

/* ---------- transactions ---------- */
const txSchema = z.object({ used_at: z.string().min(10), merchant: z.string().max(120).nullable().optional(), amount: z.number(), category: z.string().max(40).nullable().optional(), status: z.enum(["approved", "cancelled", "confirmed"]).optional() });
routes.get("/transactions", async (c) => {
  const month = c.req.query("month");
  const rows = month
    ? await all<CardTransaction>(c.env.DB, "SELECT * FROM card_transactions WHERE user_id=? AND substr(used_at,1,7)=? ORDER BY used_at DESC", uid(c), month)
    : await all<CardTransaction>(c.env.DB, "SELECT * FROM card_transactions WHERE user_id=? ORDER BY used_at DESC LIMIT 500", uid(c));
  return c.json({ transactions: rows });
});
routes.post("/transactions", async (c) => {
  const b = txSchema.parse(await c.req.json()); const id = newId();
  await run(c.env.DB, "INSERT INTO card_transactions (id,user_id,used_at,merchant,amount,category,source,status) VALUES (?,?,?,?,?,?,'manual',?)", id, uid(c), b.used_at, b.merchant ?? null, b.amount, b.category ?? null, b.status ?? "approved");
  return c.json(await one(c.env.DB, "SELECT * FROM card_transactions WHERE id=?", id), 201);
});
routes.put("/transactions/:id", async (c) => {
  const b = txSchema.partial().parse(await c.req.json()); const id = c.req.param("id");
  const cur = await one<CardTransaction>(c.env.DB, "SELECT * FROM card_transactions WHERE id=? AND user_id=?", id, uid(c));
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...b };
  await run(c.env.DB, "UPDATE card_transactions SET used_at=?, merchant=?, amount=?, category=?, status=? WHERE id=?", n.used_at, n.merchant ?? null, n.amount, n.category ?? null, n.status, id);
  return c.json(await one(c.env.DB, "SELECT * FROM card_transactions WHERE id=?", id));
});
routes.delete("/transactions/:id", async (c) => { await run(c.env.DB, "DELETE FROM card_transactions WHERE id=? AND user_id=?", c.req.param("id"), uid(c)); return c.json({ ok: true }); });

/* ---------- statements ---------- */
const stSchema = z.object({ billing_month: z.string().regex(/^\d{4}-\d{2}$/), amount: z.number(), debit_date: z.string().nullable().optional(), confirmed: z.boolean().optional(), paid: z.boolean().optional(), note: z.string().nullable().optional() });
routes.get("/statements", async (c) => c.json({ statements: await all<CardStatement>(c.env.DB, "SELECT * FROM card_statements WHERE user_id=? ORDER BY billing_month DESC", uid(c)) }));
routes.post("/statements", async (c) => {
  const b = stSchema.parse(await c.req.json()); const id = newId();
  await run(c.env.DB, "INSERT INTO card_statements (id,user_id,billing_month,amount,debit_date,confirmed,paid,note) VALUES (?,?,?,?,?,?,?,?)", id, uid(c), b.billing_month, b.amount, b.debit_date ?? null, b.confirmed ? 1 : 0, b.paid ? 1 : 0, b.note ?? null);
  return c.json(await one(c.env.DB, "SELECT * FROM card_statements WHERE id=?", id), 201);
});
routes.put("/statements/:id", async (c) => {
  const b = stSchema.partial().parse(await c.req.json()); const id = c.req.param("id");
  const cur = await one<CardStatement>(c.env.DB, "SELECT * FROM card_statements WHERE id=? AND user_id=?", id, uid(c));
  if (!cur) return c.json({ error: "not found" }, 404);
  await run(c.env.DB, "UPDATE card_statements SET billing_month=?, amount=?, debit_date=?, confirmed=?, paid=?, note=? WHERE id=?",
    b.billing_month ?? cur.billing_month, b.amount ?? cur.amount, b.debit_date === undefined ? cur.debit_date : b.debit_date, b.confirmed === undefined ? cur.confirmed : b.confirmed ? 1 : 0, b.paid === undefined ? cur.paid : b.paid ? 1 : 0, b.note === undefined ? cur.note : b.note, id);
  return c.json(await one(c.env.DB, "SELECT * FROM card_statements WHERE id=?", id));
});
routes.delete("/statements/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM card_transactions WHERE statement_id=? AND user_id=? AND source='csv'", c.req.param("id"), uid(c));
  await run(c.env.DB, "DELETE FROM card_statements WHERE id=? AND user_id=?", c.req.param("id"), uid(c));
  return c.json({ ok: true });
});
/** Statement CSV → card_statements (confirmed by the user) + csv lines (status 'confirmed'). */
routes.post("/import/csv", async (c) => {
  const b = z.object({ csv: z.string().min(1), billing_month: z.string().regex(/^\d{4}-\d{2}$/), debit_date: z.string().nullable().optional(), dry_run: z.boolean().optional() }).parse(await c.req.json());
  const p = parseStatementCsv(b.csv);
  if (!p.valid || b.dry_run) return c.json({ ...p, imported: 0 }, p.valid ? 200 : 400);
  const id = newId();
  await run(c.env.DB, "INSERT INTO card_statements (id,user_id,billing_month,amount,debit_date,confirmed,paid,line_count,csv_total) VALUES (?,?,?,?,?,1,0,?,?)", id, uid(c), b.billing_month, p.total, b.debit_date ?? null, p.lines.length, p.total);
  for (const l of p.lines) await run(c.env.DB, "INSERT INTO card_transactions (id,user_id,used_at,merchant,amount,source,status,statement_id) VALUES (?,?,?,?,?,'csv','confirmed',?)", newId(), uid(c), l.used_at, l.merchant, l.amount, id);
  return c.json({ ...p, imported: p.lines.length, statement: await one(c.env.DB, "SELECT * FROM card_statements WHERE id=?", id) });
});

/* ---------- gmail ---------- */
routes.post("/gmail/sync", async (c) => {
  try { return c.json(await syncGmail(c.env, uid(c))); } catch (e) { return c.json({ connected: true, found: 0, imported: 0, errors: [(e as Error).message] }, 502); }
});

/* ---------- settings ---------- */
routes.get("/settings", async (c) => c.json(await getSetting<CardSettings>(c.env, uid(c), "card_settings", DEFAULT_SETTINGS)));
routes.put("/settings", async (c) => { const s = settingsSchema.parse(await c.req.json()); await setSetting(c.env, uid(c), "card_settings", s); return c.json(s); });

/* ---------- insights ---------- */
routes.get("/insights", async (c) => {
  const today = jstDate(); const month = today.slice(0, 7);
  const since = new Date(Date.parse(today) - 90 * 86400e3).toISOString().slice(0, 10);
  const txs = await all<CardTransaction>(c.env.DB, "SELECT * FROM card_transactions WHERE user_id=? AND used_at>=? ORDER BY used_at", uid(c), since);
  const settings = await getSetting<CardSettings>(c.env, uid(c), "card_settings", DEFAULT_SETTINGS);
  const thisMonth = txs.filter((t) => t.used_at.slice(0, 7) === month);
  const merchants = aggregateByMerchant(thisMonth).slice(0, 10);
  const cats = new Map<string, number>();
  for (const t of thisMonth) if (t.status !== "cancelled") cats.set(t.category || "未分類", (cats.get(t.category || "未分類") ?? 0) + t.amount);
  const day = Number(today.slice(8, 10)); const total = monthTotal(txs, month);
  const dim = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const pace = day > 0 ? (total / day) * dim : null;
  const candidates: { label: string; detail: string; amount: number }[] = [];
  if (settings.monthly_budget != null && pace != null && pace > settings.monthly_budget) candidates.push({ label: "今のペースだと予算超過", detail: `月末見込み ${Math.round(pace).toLocaleString()}円 / 予算 ${settings.monthly_budget.toLocaleString()}円`, amount: pace - settings.monthly_budget });
  for (const m of merchants.filter((x) => x.count >= 3)) candidates.push({ label: `${m.merchant} が${m.count}回`, detail: `今月 ${Math.round(m.total).toLocaleString()}円。回数の多い支出は削減候補です`, amount: m.total });
  const prevMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const prevTotal = monthTotal(txs, prevMonth);
  return c.json({ month, merchants, categories: [...cats].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total), pace_month_end: pace, prev_month: { month: prevMonth, total: prevTotal }, candidates });
});

/* ---------- chat ---------- */
routes.post("/chat", async (c) => {
  const { history } = z.object({ history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1) }).parse(await c.req.json());
  const ov = await buildOverview(c.env, uid(c));
  const ctxMsg = `【参照データ】カード利用: ${JSON.stringify({ month: ov.month, month_total: ov.month_total, budget: ov.budget, budget_left: ov.budget_left, statement: ov.statement, notified_unpaid: ov.notified_unpaid, guide: ov.guide, top: aggregateByMerchant(ov.timeline).slice(0, 8) })}\n`;
  const h = history.map((m, i) => (i === 0 && m.role === "user" ? { ...m, content: ctxMsg + "\n" + m.content } : m));
  const r = await adviseWithContext(c.env, uid(c), "ファイナンシャルプランナー。カード利用の見直しと代替案を提案する。送金や購入は実行しない", h);
  return c.json({ reply: r.text, provider: r.provider });
});
