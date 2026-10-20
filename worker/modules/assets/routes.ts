import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../env";
import { all, one, run, newId, getSetting, setSetting, jstDate } from "../../core/db";
import { adviseWithContext } from "../../core/context";
import type { AssetAccount, AssetBalance, AssetPlan, BalancesResponse, LatestBalance, AssetOverview, AssetCategory, OwnerType } from "@shared/assets";
import { ASSET_CATEGORIES } from "@shared/assets";
import { computeJpy, fillFromPrevious, freshPersonalCash, computeAllocation, isStale, daysBetween, toCsv, parseBalanceCsv } from "./logic";
import { authorizeUrl, exchangeCode, freeeConfigured, loadToken, saveToken, deleteToken, listCompanies, listWalletables, syncFreeeBalances, lastSyncInfo } from "./freee";

export const routes = new Hono<AppEnv>();

const accountBase = z.object({
  name: z.string().min(1).max(80),
  owner: z.string().min(1).max(80),
  owner_type: z.enum(["personal", "corporate"]),
  category: z.enum(ASSET_CATEGORIES),
  currency: z.string().min(1).max(10),
  unit: z.string().max(20).nullable().optional(),
  source: z.enum(["manual", "freee"]),
  freee_company_id: z.string().nullable().optional(),
  freee_walletable_id: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
});
const accountSchema = accountBase.extend({ owner: accountBase.shape.owner.default("personal"), owner_type: accountBase.shape.owner_type.default("personal"), currency: accountBase.shape.currency.default("JPY"), source: accountBase.shape.source.default("manual") });
// Partial update: no defaults here, otherwise zod 4 would reset omitted fields (owner/currency/source) to their defaults.
const accountPatchSchema = accountBase.partial().extend({ archived: z.boolean().optional() });

const uid = (c: any) => c.get("user").id as string;

/* ---------- accounts ---------- */
routes.get("/accounts", async (c) => {
  const withArchived = c.req.query("all") === "1";
  const rows = await all<AssetAccount>(c.env.DB, `SELECT * FROM asset_accounts WHERE user_id=? ${withArchived ? "" : "AND archived_at IS NULL"} ORDER BY owner_type, sort_order, created_at`, uid(c));
  return c.json({ accounts: rows });
});
routes.post("/accounts", async (c) => {
  const b = accountSchema.parse(await c.req.json());
  const id = newId();
  await run(c.env.DB, "INSERT INTO asset_accounts (id,user_id,owner,owner_type,category,name,currency,unit,source,freee_company_id,freee_walletable_id,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    id, uid(c), b.owner, b.owner_type, b.category, b.name, b.currency.toUpperCase(), b.unit ?? null, b.source, b.freee_company_id ?? null, b.freee_walletable_id ?? null, b.sort_order ?? 0);
  return c.json(await one(c.env.DB, "SELECT * FROM asset_accounts WHERE id=?", id), 201);
});
routes.put("/accounts/:id", async (c) => {
  const b = accountPatchSchema.parse(await c.req.json());
  const id = c.req.param("id");
  const cur = await one<AssetAccount>(c.env.DB, "SELECT * FROM asset_accounts WHERE id=? AND user_id=?", id, uid(c));
  if (!cur) return c.json({ error: "not found" }, 404);
  const n = { ...cur, ...b, currency: (b.currency ?? cur.currency).toUpperCase() };
  const archivedAt = b.archived === undefined ? cur.archived_at : b.archived ? new Date().toISOString() : null;
  await run(c.env.DB, "UPDATE asset_accounts SET owner=?,owner_type=?,category=?,name=?,currency=?,unit=?,source=?,freee_company_id=?,freee_walletable_id=?,sort_order=?,archived_at=? WHERE id=?",
    n.owner, n.owner_type, n.category, n.name, n.currency, n.unit ?? null, n.source, n.freee_company_id ?? null, n.freee_walletable_id ?? null, n.sort_order ?? 0, archivedAt, id);
  return c.json(await one(c.env.DB, "SELECT * FROM asset_accounts WHERE id=?", id));
});
routes.delete("/accounts/:id", async (c) => {
  const id = c.req.param("id");
  const hasBal = await one(c.env.DB, "SELECT 1 FROM asset_balances WHERE account_id=? AND user_id=?", id, uid(c));
  if (hasBal) { await run(c.env.DB, "UPDATE asset_accounts SET archived_at=datetime('now') WHERE id=? AND user_id=?", id, uid(c)); return c.json({ ok: true, archived: true }); }
  await run(c.env.DB, "DELETE FROM asset_accounts WHERE id=? AND user_id=?", id, uid(c));
  return c.json({ ok: true, archived: false });
});

/* ---------- balances ---------- */
async function latestPerAccount(db: D1Database, userId: string, today: string, upTo?: string): Promise<Record<string, LatestBalance>> {
  const rows = await all<AssetBalance>(db,
    `SELECT b.* FROM asset_balances b WHERE b.user_id=? AND b.id = (SELECT id FROM asset_balances x WHERE x.account_id=b.account_id ${upTo ? "AND x.recorded_on<=?" : ""} ORDER BY recorded_on DESC, created_at DESC LIMIT 1)`,
    ...(upTo ? [userId, upTo] : [userId]));
  const out: Record<string, LatestBalance> = {};
  for (const r of rows) out[r.account_id] = { ...r, stale: isStale(r.recorded_on, today), age_days: daysBetween(r.recorded_on, today) };
  return out;
}
function filterAccounts(accounts: AssetAccount[], owner?: string, category?: string) {
  return accounts.filter((a) => (!owner || owner === "all" || a.owner === owner || a.owner_type === owner) && (!category || category === "all" || a.category === category));
}

routes.get("/balances", async (c) => {
  const today = jstDate();
  const to = c.req.query("to") || today;
  const from = c.req.query("from") || new Date(Date.parse(to) - 365 * 86400e3).toISOString().slice(0, 10);
  const accounts = filterAccounts(await all<AssetAccount>(c.env.DB, "SELECT * FROM asset_accounts WHERE user_id=? AND archived_at IS NULL ORDER BY owner_type, sort_order, created_at", uid(c)), c.req.query("owner"), c.req.query("category"));
  const ids = new Set(accounts.map((a) => a.id));
  const rowsAll = await all<AssetBalance>(c.env.DB, "SELECT * FROM asset_balances WHERE user_id=? AND recorded_on<=? ORDER BY recorded_on, created_at", uid(c), to);
  const rows = rowsAll.filter((r) => ids.has(r.account_id));
  const inRange = rows.filter((r) => r.recorded_on >= from);
  const dates = [...new Set(inRange.map((r) => r.recorded_on))].sort();
  // Series: for each recorded date, total of the latest known value per account as of that date (carry-forward flagged).
  const state = new Map<string, { date: string; jpy: number | null }>();
  let ri = 0;
  const series: BalancesResponse["series"] = [];
  for (const d of dates) {
    while (ri < rows.length && rows[ri].recorded_on <= d) { const r = rows[ri++]; state.set(r.account_id, { date: r.recorded_on, jpy: r.jpy_value }); }
    let total = 0, carried = false;
    for (const a of accounts) { if (a.category === "liability") continue; const s = state.get(a.id); if (!s || s.jpy == null) continue; total += s.jpy; if (s.date !== d) carried = true; }
    series.push({ date: d, total, carried });
  }
  const latest = await latestPerAccount(c.env.DB, uid(c), today);
  for (const k of Object.keys(latest)) if (!ids.has(k)) delete latest[k];
  const res: BalancesResponse = { from, to, recorded_range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null, accounts, series, latest, rows: inRange };
  return c.json(res);
});

const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fillFromPrevious: z.boolean().optional(),
  entries: z.array(z.object({ account_id: z.string(), quantity: z.number().nullable(), rate: z.number().nullable().optional(), rate_date: z.string().nullable().optional(), jpy_value: z.number().nullable().optional() })),
});
routes.post("/balances", async (c) => {
  const b = entrySchema.parse(await c.req.json());
  const accounts = await all<AssetAccount>(c.env.DB, "SELECT * FROM asset_accounts WHERE user_id=?", uid(c));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let entries = b.entries.filter((e) => byId.has(e.account_id));
  if (b.fillFromPrevious) {
    const prevDay = new Date(Date.parse(b.date) - 86400e3).toISOString().slice(0, 10);
    const prev = await latestPerAccount(c.env.DB, uid(c), jstDate(), prevDay);
    entries = fillFromPrevious(entries, prev);
  }
  let saved = 0;
  for (const e of entries) {
    if (e.quantity == null && e.jpy_value == null) continue; // empty = unknown: do not record
    const acc = byId.get(e.account_id)!;
    const jpy = computeJpy(acc.currency, e.quantity, e.rate ?? null, e.jpy_value ?? null);
    const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM asset_balances WHERE account_id=? AND recorded_on=? AND source IN ('manual','csv')", e.account_id, b.date);
    if (existing) await run(c.env.DB, "UPDATE asset_balances SET quantity=?, rate=?, rate_date=?, rate_source=?, jpy_value=?, source='manual' WHERE id=?", e.quantity, e.rate ?? null, e.rate_date ?? (e.rate != null ? b.date : null), e.rate != null ? "manual" : null, jpy, existing.id);
    else await run(c.env.DB, "INSERT INTO asset_balances (id,account_id,user_id,recorded_on,quantity,rate,rate_date,rate_source,jpy_value,source) VALUES (?,?,?,?,?,?,?,?,?,'manual')", newId(), e.account_id, uid(c), b.date, e.quantity, e.rate ?? null, e.rate_date ?? (e.rate != null ? b.date : null), e.rate != null ? "manual" : null, jpy);
    saved++;
  }
  return c.json({ ok: true, saved, filled: b.fillFromPrevious ? entries.filter((e, i) => e.quantity != null && b.entries[i]?.quantity == null).length : 0 });
});
routes.delete("/balances/:id", async (c) => {
  await run(c.env.DB, "DELETE FROM asset_balances WHERE id=? AND user_id=?", c.req.param("id"), uid(c));
  return c.json({ ok: true });
});

/* ---------- CSV ---------- */
routes.get("/export.csv", async (c) => {
  const rows = await all<AssetBalance & { account: string }>(c.env.DB, "SELECT b.*, a.name account FROM asset_balances b JOIN asset_accounts a ON a.id=b.account_id WHERE b.user_id=? ORDER BY b.recorded_on, a.sort_order, a.name", uid(c));
  const csv = toCsv(rows.map((r) => ({ date: r.recorded_on, account: r.account, quantity: r.quantity, rate: r.rate, jpy_value: r.jpy_value })));
  return new Response("﻿" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="assets-${jstDate()}.csv"` } });
});
routes.post("/import", async (c) => {
  const { csv } = z.object({ csv: z.string().min(1) }).parse(await c.req.json());
  const { rows, errors } = parseBalanceCsv(csv);
  const accounts = await all<AssetAccount>(c.env.DB, "SELECT * FROM asset_accounts WHERE user_id=?", uid(c));
  const byName = new Map(accounts.map((a) => [a.name, a]));
  let imported = 0;
  for (const r of rows) {
    const acc = byName.get(r.account);
    if (!acc) { errors.push(`口座「${r.account}」が見つかりません`); continue; }
    if (r.quantity == null && r.jpy_value == null) continue;
    const jpy = computeJpy(acc.currency, r.quantity, r.rate, r.jpy_value);
    const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM asset_balances WHERE account_id=? AND recorded_on=? AND source IN ('manual','csv')", acc.id, r.date);
    if (existing) await run(c.env.DB, "UPDATE asset_balances SET quantity=?, rate=?, jpy_value=?, source='csv' WHERE id=?", r.quantity, r.rate, jpy, existing.id);
    else await run(c.env.DB, "INSERT INTO asset_balances (id,account_id,user_id,recorded_on,quantity,rate,rate_date,rate_source,jpy_value,source) VALUES (?,?,?,?,?,?,?,?,?,'csv')", newId(), acc.id, uid(c), r.date, r.quantity, r.rate, r.rate != null ? r.date : null, r.rate != null ? "csv" : null, jpy);
    imported++;
  }
  return c.json({ imported, errors });
});

/* ---------- overview / plan / allocation ---------- */
async function overview(db: D1Database, userId: string): Promise<AssetOverview> {
  const today = jstDate();
  const accounts = await all<AssetAccount>(db, "SELECT * FROM asset_accounts WHERE user_id=? AND archived_at IS NULL ORDER BY owner_type, sort_order, created_at", userId);
  const latest = await latestPerAccount(db, userId, today);
  const byOwner = new Map<OwnerType, { total: number; stale: boolean }>();
  const byCat = new Map<AssetCategory, { total: number; stale: boolean }>();
  let total: number | null = null, liabilities: number | null = null, staleCount = 0, unknownCount = 0, asOf: string | null = null;
  for (const a of accounts) {
    const l = latest[a.id];
    if (!l || l.jpy_value == null) { unknownCount++; continue; }
    if (l.stale) staleCount++;
    if (!asOf || l.recorded_on > asOf) asOf = l.recorded_on;
    if (a.category === "liability") { liabilities = (liabilities ?? 0) + l.jpy_value; }
    else {
      total = (total ?? 0) + l.jpy_value;
      const o = byOwner.get(a.owner_type) ?? { total: 0, stale: false }; o.total += l.jpy_value; o.stale ||= l.stale; byOwner.set(a.owner_type, o);
    }
    const k = byCat.get(a.category) ?? { total: 0, stale: false }; k.total += l.jpy_value; k.stale ||= l.stale; byCat.set(a.category, k);
  }
  return {
    as_of: asOf, total, liabilities,
    by_owner_type: [...byOwner].map(([owner_type, v]) => ({ owner_type, ...v })),
    by_category: [...byCat].map(([category, v]) => ({ category, ...v })),
    accounts: accounts.map((a) => ({ ...a, latest: latest[a.id] ?? null })),
    stale_count: staleCount, unknown_count: unknownCount,
  };
}
routes.get("/overview", async (c) => c.json(await overview(c.env.DB, uid(c))));

const planSchema = z.object({
  living_cost_monthly: z.number().nullable().default(null),
  planned_expenses: z.array(z.object({ label: z.string(), amount: z.number(), due: z.string().nullable().optional() })).default([]),
  debts: z.array(z.object({ label: z.string(), amount: z.number() })).default([]),
  reserve_amount: z.number().nullable().default(null),
  income_next: z.object({ date: z.string().nullable(), amount: z.number().nullable() }).nullable().default(null),
});
const DEFAULT_PLAN: AssetPlan = { living_cost_monthly: null, planned_expenses: [], debts: [], reserve_amount: null, income_next: null };
routes.get("/plan", async (c) => c.json(await getSetting<AssetPlan>(c.env, uid(c), "asset_plan", DEFAULT_PLAN)));
routes.put("/plan", async (c) => { const p = planSchema.parse(await c.req.json()); await setSetting(c.env, uid(c), "asset_plan", p); return c.json(p); });

async function allocation(env: AppEnv["Bindings"], userId: string) {
  const today = jstDate();
  const accounts = await all<AssetAccount>(env.DB, "SELECT * FROM asset_accounts WHERE user_id=? AND archived_at IS NULL", userId);
  const latest = await latestPerAccount(env.DB, userId, today);
  const cash = freshPersonalCash(accounts.filter((a) => latest[a.id]).map((a) => ({ account: a, recorded_on: latest[a.id].recorded_on, jpy_value: latest[a.id].jpy_value })), today);
  const plan = await getSetting<AssetPlan>(env, userId, "asset_plan", DEFAULT_PLAN);
  return computeAllocation(cash, plan, today);
}
routes.get("/allocation", async (c) => c.json(await allocation(c.env, uid(c))));

/* ---------- FP chat ---------- */
routes.post("/chat", async (c) => {
  const { history } = z.object({ history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1) }).parse(await c.req.json());
  const [ov, plan, alloc] = await Promise.all([overview(c.env.DB, uid(c)), getSetting<AssetPlan>(c.env, uid(c), "asset_plan", DEFAULT_PLAN), allocation(c.env, uid(c))]);
  const ctxMsg = `【参照データ】資産概要: ${JSON.stringify({ ...ov, accounts: ov.accounts.map((a) => ({ name: a.name, owner: a.owner, category: a.category, jpy: a.latest?.jpy_value ?? null, recorded_on: a.latest?.recorded_on ?? null, stale: a.latest?.stale ?? true })) })}\n計画: ${JSON.stringify(plan)}\n配分案: ${JSON.stringify(alloc)}\n`;
  const h = history.map((m, i) => (i === 0 && m.role === "user" ? { ...m, content: ctxMsg + "\n" + m.content } : m));
  const r = await adviseWithContext(c.env, uid(c), "ファイナンシャルプランナー。送金や購入は実行しない", h);
  return c.json({ reply: r.text, provider: r.provider });
});

/* ---------- freee ---------- */
routes.get("/freee/status", async (c) => {
  const t = await loadToken(c.env, uid(c));
  const last = await lastSyncInfo(c.env, uid(c));
  return c.json({ configured: freeeConfigured(c.env), connected: Boolean(t), companies: t?.companies ?? [], connected_at: t?.connected_at ?? null, last_sync: last });
});
routes.get("/freee/start", async (c) => {
  if (!freeeConfigured(c.env)) return c.json({ error: "freeeのクライアント設定（FREEE_CLIENT_ID / FREEE_CLIENT_SECRET）がありません" }, 503);
  const state = newId();
  await setSetting(c.env, uid(c), "freee_oauth_state", { state, at: Date.now() });
  return c.json({ url: authorizeUrl(c.env, new URL(c.req.url).origin, state) });
});
routes.get("/freee/callback", async (c) => {
  const code = c.req.query("code"); const state = c.req.query("state");
  const saved = await getSetting<{ state: string; at: number } | null>(c.env, uid(c), "freee_oauth_state", null);
  if (!code || !state || !saved || saved.state !== state || Date.now() - saved.at > 15 * 60e3) return c.redirect("/assets?freee=error");
  try {
    const t = await exchangeCode(c.env, new URL(c.req.url).origin, code);
    await saveToken(c.env, uid(c), t);
    await setSetting(c.env, uid(c), "freee_oauth_state", null);
    try { await listCompanies(c.env, uid(c)); } catch { /* companies can be listed later */ }
    return c.redirect("/assets?freee=connected");
  } catch (e) { console.error("freee callback", e); return c.redirect("/assets?freee=error"); }
});
routes.post("/freee/sync", async (c) => c.json(await syncFreeeBalances(c.env, uid(c))));
routes.post("/freee/disconnect", async (c) => { await deleteToken(c.env, uid(c)); return c.json({ ok: true }); });
routes.get("/freee/companies", async (c) => { try { return c.json({ companies: await listCompanies(c.env, uid(c)) }); } catch (e) { return c.json({ error: (e as Error).message }, 502); } });
routes.get("/freee/companies/:id/walletables", async (c) => { try { return c.json({ walletables: await listWalletables(c.env, uid(c), c.req.param("id")) }); } catch (e) { return c.json({ error: (e as Error).message }, 502); } });
