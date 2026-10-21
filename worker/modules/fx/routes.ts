import { Hono } from "hono";
import { zipSync, strToU8 } from "fflate";
import connectorPy from "../../../connector/lifeos_connector.py?raw";
import connectorReadme from "../../../connector/README.md?raw";
import connectorRequirements from "../../../connector/requirements.txt?raw";
import agentPy from "../../../connector/lifeos_agent.py?raw";
import mt5AdapterPy from "../../../connector/mt5_adapter.py?raw";
import mt5CommonPy from "../../../connector/mt5_common.py?raw";
import mt5TimePy from "../../../connector/mt5_time.py?raw";
import ruleAEnginePy from "../../../connector/rule_a_engine.py?raw";
import donchianEnginePy from "../../../connector/donchian_engine.py?raw";
import donchianV6EnginePy from "../../../connector/donchian_v6_engine.py?raw";
import ruleAAgentPy from "../../../connector/rule_a_agent.py?raw";
import donchianAgentPy from "../../../connector/donchian_agent.py?raw";
import donchianV6AgentPy from "../../../connector/donchian_v6_agent.py?raw";
import autoStrategiesPy from "../../../connector/auto_strategies.py?raw";
import { z } from "zod";
import type { AppEnv, Env } from "../../env";
import { all, one, run, newId, getSetting, setSetting, nowIso } from "../../core/db";
import { notify } from "../../core/notify";
import {
  PAIRS, RULES, RULE_KEYS, TIMEFRAMES, TF_SECONDS, DEFAULT_FX_SETTINGS, YEAR_CONFIG_VALID_UNTIL, CONNECTOR_STALE_MS, LEASE_SECONDS, pipSize,
  type FxSettings, type Permissions, type LeaseInfo, type Rule, type Timeframe, type PairsResponse, type PairView, type SetupMark,
  type ChartResponse, type ChartLine, type ChartLevel, type ChartMarker, type CandleBar, type TradeRow, type StatusResponse, type PerformanceResponse, type HeartbeatPayload,
} from "@shared/fx";
import {
  setupMarkFor, rLimitsBlockNewEntries, yearConfigValid, sma, atr, adx, dailyPivots, aggregateDailyJst06, slTpForBuy, slTpForSell, SL_MULTIPLIER, missingRanges,
} from "./logic";

/* ------------------------------------------------------------ helpers */
const LEASE_KEY = "fx:lease";
type LeaseRec = { holder: string; expires_at: string };

async function readLease(env: Env): Promise<LeaseRec | null> {
  const v = await env.KV.get<LeaseRec>(LEASE_KEY, "json");
  if (!v) return null;
  if (Date.parse(v.expires_at) <= Date.now()) return null;
  return v;
}
async function leaseInfo(env: Env, terminalId: string | null): Promise<LeaseInfo> {
  const l = await readLease(env);
  return { holder: l?.holder ?? null, expires_at: l?.expires_at ?? null, held_by_you: Boolean(l && terminalId && l.holder === terminalId) };
}

/** The connector authenticates with a shared token; data belongs to the owner (first allowed email). */
async function ownerUserId(env: Env): Promise<string | null> {
  const email = (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)[0];
  if (!email) return null;
  const row = await one<{ id: string }>(env.DB, "SELECT id FROM users WHERE email=?", email);
  return row?.id ?? null;
}

async function loadSettings(env: Env, userId: string): Promise<FxSettings> {
  const s = await getSetting<Partial<FxSettings>>(env, userId, "fx_settings", {});
  return {
    ...DEFAULT_FX_SETTINGS, ...s,
    rules: { ...DEFAULT_FX_SETTINGS.rules, ...(s.rules ?? {}) },
    trading_hours: { ...DEFAULT_FX_SETTINGS.trading_hours, ...(s.trading_hours ?? {}) },
    r_limits: { ...DEFAULT_FX_SETTINGS.r_limits, ...(s.r_limits ?? {}) },
    stop_reasons: s.stop_reasons ?? [],
  };
}

type StateRow = { payload_json: string; received_at: string };
async function loadState(env: Env, userId: string): Promise<{ payload: HeartbeatPayload | null; received_at: string | null; online: boolean }> {
  const row = await one<StateRow>(env.DB, "SELECT payload_json, received_at FROM fx_connector_state WHERE user_id=?", userId);
  if (!row) return { payload: null, received_at: null, online: false };
  let payload: HeartbeatPayload | null = null;
  try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
  const online = Date.now() - new Date(row.received_at).getTime() < CONNECTOR_STALE_MS;
  return { payload, received_at: row.received_at, online };
}

async function rBlock(env: Env, userId: string, settings: FxSettings) {
  const since = new Date(Date.now() - 40 * 86400_000).toISOString();
  const closed = await all<{ close_at: string | null; r_multiple: number | null; status: string }>(env.DB,
    "SELECT close_at, r_multiple, status FROM fx_trades WHERE user_id=? AND status='closed' AND close_at>=?", userId, since);
  return rLimitsBlockNewEntries(closed, Date.now(), settings.r_limits);
}

async function buildPermissions(env: Env, userId: string, terminalId: string | null): Promise<Permissions> {
  const settings = await loadSettings(env, userId);
  const block = await rBlock(env, userId, settings);
  const valid = yearConfigValid(Date.now());
  const enabled = RULE_KEYS.filter((r) => settings.rules[r].enabled && (r === "rule_a" || valid));
  return {
    enabled_rules: enabled, common_lot: settings.common_lot, risk_usd_donchian6: settings.risk_usd_donchian6,
    trading_hours: settings.trading_hours, r_limits: settings.r_limits, r_limit_block: block,
    year_config_valid_until: YEAR_CONFIG_VALID_UNTIL, year_config_valid: valid,
    lease: await leaseInfo(env, terminalId), server_time: nowIso(),
  };
}

/* ------------------------------------------------------- zod schemas */
const ruleZ = z.enum(["rule_a", "donchian4", "donchian6"]);
const sideZ = z.enum(["BUY", "SELL"]);
const pairZ = z.string().regex(/^[A-Z]{3}\/[A-Z]{3}$/);
const isoZ = z.string().refine((s) => Number.isFinite(Date.parse(s)), "invalid datetime");

const heartbeatZ = z.object({
  terminal_id: z.string().min(1).max(100),
  account: z.string().max(100).default(""),
  equity: z.number().nullable().default(null),
  positions: z.array(z.object({
    ticket: z.union([z.string(), z.number()]).transform(String), rule: ruleZ, pair: pairZ, side: sideZ, lots: z.number(), open_price: z.number(),
    sl: z.number().nullable().default(null), tp: z.number().nullable().default(null), open_at: isoZ, pnl_usd: z.number().nullable().optional(),
  })).default([]),
  lease_holder: z.string().optional(),
  version: z.string().max(50).default("unknown"),
  mt5_connected: z.boolean().optional(),
  stop_reasons: z.array(z.string().max(200)).max(50).optional(),
});
const signalZ = z.object({
  pair: pairZ, rule: ruleZ, side: sideZ.nullable().default(null), stage: z.enum(["none", "setup", "entry"]), bar_time: isoZ,
  indicators: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),
});
const tradeZ = z.object({
  event: z.enum(["open", "add", "close", "modify"]), ticket: z.union([z.string(), z.number()]).transform(String), rule: ruleZ, pair: pairZ, side: sideZ,
  price: z.number(), lots: z.number(), sl: z.number().nullable().default(null), tp: z.number().nullable().default(null),
  pnl_usd: z.number().nullable().optional(), r_multiple: z.number().nullable().optional(), at: isoZ,
  group_ticket: z.union([z.string(), z.number()]).transform(String).nullable().optional(), note: z.string().max(500).nullable().optional(),
});
const candlesZ = z.object({
  pair: pairZ, timeframe: z.enum(["M5", "H1", "H4", "D1"]),
  bars: z.array(z.object({ t: z.number().int().positive(), o: z.number(), h: z.number(), l: z.number(), c: z.number() })).min(1).max(2000),
});
const quoteZ = z.object({ pair: pairZ, bid: z.number(), ask: z.number(), at: isoZ });
const settingsZ = z.object({
  rules: z.object({ rule_a: z.object({ enabled: z.boolean() }), donchian4: z.object({ enabled: z.boolean() }), donchian6: z.object({ enabled: z.boolean() }) }),
  common_lot: z.number().min(0.01).max(50),
  risk_usd_donchian6: z.number().min(1).max(100000),
  trading_hours: z.object({ start_utc: z.number().int().min(0).max(23), end_utc: z.number().int().min(1).max(24), weekdays_only: z.boolean() }),
  r_limits: z.object({ day: z.number().max(0), week: z.number().max(0), month: z.number().max(0) }),
  stop_reasons: z.array(z.string().max(200)).max(50),
});

/* ====================================================== public routes */
export const publicRoutes = new Hono<AppEnv>();

publicRoutes.use("*", async (c, next) => {
  const token = c.env.FX_CONNECTOR_TOKEN;
  const auth = c.req.header("Authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  const uid = await ownerUserId(c.env);
  if (!uid) return c.json({ error: "owner not registered" }, 503);
  c.set("user", { id: uid, email: "", name: null, picture: null });
  await next();
});

publicRoutes.post("/heartbeat", async (c) => {
  const body = heartbeatZ.parse(await c.req.json());
  const uid = c.get("user").id;
  // Single-terminal lease: acquire or renew; refuse when another live terminal holds it.
  const cur = await readLease(c.env);
  if (cur && cur.holder !== body.terminal_id) {
    return c.json({ error: "lease held by another terminal", lease: { holder: cur.holder, expires_at: cur.expires_at, held_by_you: false } }, 409);
  }
  const expires = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();
  await c.env.KV.put(LEASE_KEY, JSON.stringify({ holder: body.terminal_id, expires_at: expires } satisfies LeaseRec), { expirationTtl: 60 });
  const received = nowIso();
  await run(c.env.DB, "INSERT INTO fx_connector_state (user_id,payload_json,received_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload_json=excluded.payload_json, received_at=excluded.received_at",
    uid, JSON.stringify({ ...body, lease_holder: body.terminal_id }), received);
  const perms = await buildPermissions(c.env, uid, body.terminal_id);
  return c.json({ ok: true, received_at: received, permissions: perms });
});

publicRoutes.post("/signals", async (c) => {
  const raw = await c.req.json();
  const items = (Array.isArray(raw) ? raw : [raw]).map((x) => signalZ.parse(x));
  const uid = c.get("user").id;
  for (const s of items) {
    await run(c.env.DB, "INSERT INTO fx_signals (id,user_id,pair,rule,side,stage,bar_time,payload_json,received_at) VALUES (?,?,?,?,?,?,?,?,?)",
      newId(), uid, s.pair, s.rule, s.side ?? "", s.stage, s.bar_time, JSON.stringify(s.indicators ?? {}), nowIso());
  }
  return c.json({ ok: true, stored: items.length });
});

const EVENT_LABEL: Record<string, string> = { open: "エントリー", add: "追加", close: "決済", modify: "SL/TP更新" };
publicRoutes.post("/trades", async (c) => {
  const raw = await c.req.json();
  const items = (Array.isArray(raw) ? raw : [raw]).map((x) => tradeZ.parse(x));
  const uid = c.get("user").id;
  let stored = 0, duplicates = 0;
  for (const t of items) {
    const key = t.event === "modify" ? `${t.ticket}:modify:${t.at}` : `${t.ticket}:${t.event}`;
    const dup = await one(c.env.DB, "SELECT 1 FROM fx_trade_events WHERE user_id=? AND event_key=?", uid, key);
    if (dup) { duplicates++; continue; }
    await run(c.env.DB, "INSERT INTO fx_trade_events (user_id,event_key,ticket,event,rule,pair,payload_json,at) VALUES (?,?,?,?,?,?,?,?)", uid, key, t.ticket, t.event, t.rule, t.pair, JSON.stringify(t), t.at);
    const existing = await one<{ id: string }>(c.env.DB, "SELECT id FROM fx_trades WHERE user_id=? AND ticket=?", uid, t.ticket);
    if (t.event === "open" || t.event === "add") {
      if (!existing) {
        await run(c.env.DB, "INSERT INTO fx_trades (id,user_id,rule,pair,side,ticket,open_at,open_price,lots,sl,tp,status,payload_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?,?)",
          newId(), uid, t.rule, t.pair, t.side, t.ticket, t.at, t.price, t.lots, t.sl, t.tp, JSON.stringify({ group_ticket: t.group_ticket ?? null, note: t.note ?? null }), nowIso());
      }
    } else if (t.event === "close") {
      if (existing) {
        await run(c.env.DB, "UPDATE fx_trades SET close_at=?, close_price=?, pnl_usd=?, r_multiple=?, status='closed' WHERE id=?", t.at, t.price, t.pnl_usd ?? null, t.r_multiple ?? null, existing.id);
      } else {
        // Close for a leg we never saw opened (e.g. connector restarted): keep it, do not fabricate the open price.
        await run(c.env.DB, "INSERT INTO fx_trades (id,user_id,rule,pair,side,ticket,close_at,close_price,lots,pnl_usd,r_multiple,status,payload_json,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'closed',?,?)",
          newId(), uid, t.rule, t.pair, t.side, t.ticket, t.at, t.price, t.lots, t.pnl_usd ?? null, t.r_multiple ?? null, JSON.stringify({ open_unknown: true }), nowIso());
      }
    } else if (t.event === "modify" && existing) {
      await run(c.env.DB, "UPDATE fx_trades SET sl=?, tp=? WHERE id=?", t.sl, t.tp, existing.id);
    }
    stored++;
    if (t.event !== "modify") {
      const pip = pipSize(t.pair);
      const digits = pip === 0.01 ? 3 : 5;
      const pnl = t.event === "close" && t.pnl_usd != null ? ` 損益 ${t.pnl_usd >= 0 ? "+" : ""}${t.pnl_usd.toFixed(2)} USD${t.r_multiple != null ? ` (${t.r_multiple >= 0 ? "+" : ""}${t.r_multiple.toFixed(2)}R)` : ""}` : "";
      await notify(c.env, uid, {
        kind: "fx",
        title: `${RULES[t.rule]} ${EVENT_LABEL[t.event]} ${t.pair} ${t.side}`,
        body: `${t.lots} lot @ ${t.price.toFixed(digits)}${pnl}${t.sl != null && t.event !== "close" ? ` SL ${t.sl.toFixed(digits)}` : ""}${t.tp != null && t.event !== "close" ? ` TP ${t.tp.toFixed(digits)}` : ""}`,
        url: "/fx/trades", dedupeKey: `fx:${uid}:${key}`,
      });
    }
  }
  return c.json({ ok: true, stored, duplicates });
});

publicRoutes.post("/candles", async (c) => {
  const body = candlesZ.parse(await c.req.json());
  const tf = TF_SECONDS[body.timeframe];
  const stmts = body.bars.map((b) => c.env.DB.prepare(
    "INSERT INTO fx_candles (pair,timeframe,time,open,high,low,close) VALUES (?,?,?,?,?,?,?) ON CONFLICT(pair,timeframe,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close",
  ).bind(body.pair, body.timeframe, Math.floor(b.t / tf) * tf, b.o, b.h, b.l, b.c));
  for (let i = 0; i < stmts.length; i += 100) await c.env.DB.batch(stmts.slice(i, i + 100));
  return c.json({ ok: true, upserted: body.bars.length });
});

publicRoutes.post("/quotes", async (c) => {
  const raw = await c.req.json();
  const items = (Array.isArray(raw) ? raw : [raw]).map((x) => quoteZ.parse(x));
  for (const q of items) {
    await run(c.env.DB, "INSERT INTO fx_quotes (pair,bid,ask,quoted_at) VALUES (?,?,?,?) ON CONFLICT(pair) DO UPDATE SET bid=excluded.bid, ask=excluded.ask, quoted_at=excluded.quoted_at", q.pair, q.bid, q.ask, q.at);
  }
  return c.json({ ok: true, stored: items.length });
});

publicRoutes.get("/permissions", async (c) => {
  const uid = c.get("user").id;
  return c.json(await buildPermissions(c.env, uid, c.req.query("terminal_id") ?? null));
});

/* ================================================= authenticated routes */
export const routes = new Hono<AppEnv>();

routes.get("/", (c) => c.json({ module: "fx", ok: true }));

routes.get("/pairs", async (c) => {
  const uid = c.get("user").id;
  const [settings, state, quotes, signals] = await Promise.all([
    loadSettings(c.env, uid), loadState(c.env, uid),
    all<{ pair: string; bid: number; ask: number; quoted_at: string }>(c.env.DB, "SELECT pair,bid,ask,quoted_at FROM fx_quotes"),
    all<{ pair: string; rule: Rule; side: string; stage: string; bar_time: string; received_at: string }>(c.env.DB,
      `SELECT pair,rule,side,stage,bar_time,received_at FROM fx_signals s WHERE user_id=? AND id IN (
         SELECT id FROM fx_signals s2 WHERE s2.user_id=s.user_id AND s2.pair=s.pair AND s2.rule=s.rule ORDER BY received_at DESC, bar_time DESC LIMIT 1)`, uid),
  ]);
  const now = Date.now();
  const qmap = new Map(quotes.map((q) => [q.pair, q]));
  const pairs: PairView[] = PAIRS.map((pair) => {
    const q = qmap.get(pair);
    const rules = RULE_KEYS.map((rule) => {
      const s = signals.find((x) => x.pair === pair && x.rule === rule) ?? null;
      const mark: SetupMark = setupMarkFor(s ? { rule, side: (s.side || null) as any, stage: s.stage as any, bar_time: s.bar_time } : null, now, state.received_at);
      return { rule, mark, enabled: settings.rules[rule].enabled, received_at: s?.received_at ?? null };
    });
    return { pair, quote: q ? { bid: q.bid, ask: q.ask, at: q.quoted_at } : null, quote_stale: !q || now - Date.parse(q.quoted_at) > 120_000, rules };
  });
  const res: PairsResponse = { connector_online: state.online, connector_last_seen: state.received_at, pairs, server_time: nowIso() };
  return c.json(res);
});

type CandleRow = { time: number; open: number; high: number; low: number; close: number };
const rowsToBars = (rows: CandleRow[]): CandleBar[] => rows.map((r) => ({ t: r.time, o: r.open, h: r.high, l: r.low, c: r.close }));
async function candlesBetween(env: Env, pair: string, tf: Timeframe, from: number, to: number) {
  return rowsToBars(await all<CandleRow>(env.DB, "SELECT time,open,high,low,close FROM fx_candles WHERE pair=? AND timeframe=? AND time>=? AND time<=? ORDER BY time", pair, tf, from, to));
}
async function lastCandles(env: Env, pair: string, tf: Timeframe, before: number, n: number) {
  const rows = await all<CandleRow>(env.DB, "SELECT time,open,high,low,close FROM fx_candles WHERE pair=? AND timeframe=? AND time<=? ORDER BY time DESC LIMIT ?", pair, tf, before, n);
  return rowsToBars(rows.reverse());
}

const COLORS = { sma10: "#0a84ff", sma90: "#af52de", sma16: "#ff9500", band: "#ff950088", breakout: "#34c759", sl: "#ff3b30", pivot: "#8e8e93", sma20: "#30b0c7" };

routes.get("/chart", async (c) => {
  const pair = c.req.query("pair") ?? "USD/JPY";
  if (!(PAIRS as readonly string[]).includes(pair)) return c.json({ error: "unknown pair" }, 400);
  const tf = (c.req.query("tf") ?? "M5") as Timeframe;
  if (!TIMEFRAMES.includes(tf)) return c.json({ error: "unknown tf" }, 400);
  const rule = (c.req.query("rule") ?? "rule_a") as Rule;
  if (!RULE_KEYS.includes(rule)) return c.json({ error: "unknown rule" }, 400);
  const uid = c.get("user").id;
  const nowSec = Math.floor(Date.now() / 1000);
  const toQ = Number(c.req.query("to")); const fromQ = Number(c.req.query("from"));
  let to = Number.isFinite(toQ) && toQ > 0 ? Math.floor(toQ) : nowSec;
  let from = Number.isFinite(fromQ) && fromQ > 0 ? Math.floor(fromQ) : to - 6 * 3600;
  if (from >= to) from = to - 6 * 3600;
  if (to - from > 30 * 86400) from = to - 30 * 86400; // max 30 calendar days per request

  const range = await one<{ lo: number | null; hi: number | null }>(c.env.DB, "SELECT MIN(time) lo, MAX(time) hi FROM fx_candles WHERE pair=? AND timeframe=?", pair, tf);
  const candles = await candlesBetween(c.env, pair, tf, from, to);
  const missing = range?.lo == null ? [{ from, to }] : missingRanges(candles, TF_SECONDS[tf], Math.max(from, range.lo), Math.min(to, range.hi ?? to));

  const lines: ChartLine[] = []; const levels: ChartLevel[] = []; const insufficient: string[] = [];
  const pip = pipSize(pair);
  const anchor = candles.length ? candles[candles.length - 1]!.t : to;
  const lineFrom = (bars: CandleBar[], series: (number | null)[], key: string, label: string, timeframe: Timeframe, color: string) => {
    const points = bars.map((b, i) => ({ time: b.t, value: series[i] })).filter((p): p is { time: number; value: number } => p.value != null && p.time >= from - TF_SECONDS[timeframe]);
    if (points.length === 0) { insufficient.push(label); return; }
    lines.push({ key, label, timeframe, points, color });
  };

  // H1 context (all rules use H1 for pullback band / SL reference). Need 90 bars of history for SMA90.
  const h1 = await lastCandles(c.env, pair, "H1", anchor, Math.ceil((to - from) / 3600) + 120);
  const h1Close = h1.map((b) => b.c);
  const h1Atr = atr(h1, 14);
  const h1Adx = adx(h1, 14);
  const lastAtr = h1Atr.length ? h1Atr[h1Atr.length - 1] : null;
  const lastAdx = h1Adx.length ? h1Adx[h1Adx.length - 1] : null;
  if (h1.length < 14) insufficient.push("ATR14(H1)");

  if (rule === "rule_a") {
    lineFrom(h1, sma(h1Close, 10), "sma10_h1", "SMA10 (H1)", "H1", COLORS.sma10);
    if (h1.length >= 90) lineFrom(h1, sma(h1Close, 90), "sma90_h1", "SMA90 (H1)", "H1", COLORS.sma90); else insufficient.push("SMA90 (H1)");
    const s16 = sma(h1Close, 16);
    const upper = s16.map((v, i) => (v != null && h1Atr[i] != null ? v + 0.35 * h1Atr[i]! : null));
    const lower = s16.map((v, i) => (v != null && h1Atr[i] != null ? v - 0.35 * h1Atr[i]! : null));
    lineFrom(h1, upper, "band_upper", "押し目帯 上 SMA16+0.35ATR", "H1", COLORS.band);
    lineFrom(h1, lower, "band_lower", "押し目帯 下 SMA16−0.35ATR", "H1", COLORS.band);
    if (h1.length >= 4) {
      const prev3 = h1.slice(-4, -1);
      levels.push({ key: "brk_high", label: "直前3本高値", price: Math.max(...prev3.map((b) => b.h)), group: "breakout", color: COLORS.breakout, dashed: true });
      levels.push({ key: "brk_low", label: "直前3本安値", price: Math.min(...prev3.map((b) => b.l)), group: "breakout", color: COLORS.breakout, dashed: true });
    }
    // M5 SMA20 (trailing reference) when the chart itself is M5
    if (tf === "M5" && candles.length >= 20) lineFrom(candles, sma(candles.map((b) => b.c), 20), "sma20_m5", "SMA20 (M5)", "M5", COLORS.sma20);
  } else {
    const h4 = await lastCandles(c.env, pair, "H4", anchor, Math.ceil((to - from) / 14400) + 120);
    const h4Close = h4.map((b) => b.c);
    if (h4.length >= 10) lineFrom(h4, sma(h4Close, 10), "sma10_h4", "SMA10 (H4)", "H4", COLORS.sma10); else insufficient.push("SMA10 (H4)");
    if (h4.length >= 90) lineFrom(h4, sma(h4Close, 90), "sma90_h4", "SMA90 (H4)", "H4", COLORS.sma90); else insufficient.push("SMA90 (H4)");
    const s16 = sma(h1Close, 16);
    lineFrom(h1, s16.map((v, i) => (v != null && h1Atr[i] != null ? v + 0.35 * h1Atr[i]! : null)), "band_upper", "押し目帯 上 SMA16+0.35ATR", "H1", COLORS.band);
    lineFrom(h1, s16.map((v, i) => (v != null && h1Atr[i] != null ? v - 0.35 * h1Atr[i]! : null)), "band_lower", "押し目帯 下 SMA16−0.35ATR", "H1", COLORS.band);
    if (h4.length >= 25) {
      const prev24 = h4.slice(-25, -1);
      levels.push({ key: "don_high", label: "H4 24本高値", price: Math.max(...prev24.map((b) => b.h)), group: "breakout", color: COLORS.breakout, dashed: true });
      levels.push({ key: "don_low", label: "H4 24本安値", price: Math.min(...prev24.map((b) => b.l)), group: "breakout", color: COLORS.breakout, dashed: true });
    } else insufficient.push("H4 24本高安");
  }

  // SL reference (origin) for both sides from the last 5 H1 bars.
  if (h1.length >= 5 && lastAtr != null) {
    const last5 = h1.slice(-5); const closeH1 = h1[h1.length - 1]!.c; const m = SL_MULTIPLIER[rule];
    const b = slTpForBuy({ lastLows5: last5.map((x) => x.l), atr14: lastAtr, closeH1, multiplier: m, pip });
    const s = slTpForSell({ lastHighs5: last5.map((x) => x.h), atr14: lastAtr, closeH1, multiplier: m, pip });
    levels.push({ key: "sl_buy", label: "SL参考 (買い)", price: b.sl, group: "sl", color: COLORS.sl, dashed: true });
    levels.push({ key: "sl_sell", label: "SL参考 (売り)", price: s.sl, group: "sl", color: COLORS.sl, dashed: true });
  } else insufficient.push("SL参考");

  // Pivots: donchian6 uses JST06:00-bucketed days from H1; A/donchian4 use the broker D1 bars.
  let pivBar: CandleBar | null = null;
  if (rule === "donchian6") {
    const days = aggregateDailyJst06(h1);
    const completed = days.filter((d) => d.t + 86400 <= anchor);
    pivBar = completed.length ? completed[completed.length - 1]! : null;
    if (!pivBar) insufficient.push("ピボット (JST06:00日足)");
  } else {
    const d1 = await lastCandles(c.env, pair, "D1", anchor - 86400, 1);
    pivBar = d1[0] ?? null;
    if (!pivBar) insufficient.push("ピボット (D1)");
  }
  if (pivBar) {
    const p = dailyPivots(pivBar);
    for (const k of ["P", "R1", "R2", "R3", "S1", "S2", "S3"] as const) levels.push({ key: `piv_${k}`, label: k, price: p[k], group: "pivot", color: COLORS.pivot, dashed: k !== "P" });
  }

  // Markers from account-wide trades + signals in range.
  const fromIso = new Date(from * 1000).toISOString(), toIso = new Date(to * 1000).toISOString();
  const trades = await all<TradeRow>(c.env.DB, "SELECT rule,pair,side,ticket,open_at,close_at,open_price,close_price FROM fx_trades WHERE user_id=? AND pair=? AND ((open_at BETWEEN ? AND ?) OR (close_at BETWEEN ? AND ?))", uid, pair, fromIso, toIso, fromIso, toIso);
  const markers: ChartMarker[] = [];
  const tfs = TF_SECONDS[tf];
  const snap = (iso: string) => Math.floor(Date.parse(iso) / 1000 / tfs) * tfs;
  for (const t of trades) {
    if (t.open_at && t.open_at >= fromIso && t.open_at <= toIso) markers.push({ time: snap(t.open_at), kind: "entry", side: t.side, label: `${RULES[t.rule]} IN`, price: t.open_price ?? undefined });
    if (t.close_at && t.close_at >= fromIso && t.close_at <= toIso) markers.push({ time: snap(t.close_at), kind: "exit", side: t.side, label: `${RULES[t.rule]} OUT`, price: t.close_price ?? undefined });
  }
  const sigs = await all<{ side: string; bar_time: string; rule: Rule }>(c.env.DB, "SELECT side,bar_time,rule FROM fx_signals WHERE user_id=? AND pair=? AND rule=? AND stage='entry' AND bar_time BETWEEN ? AND ?", uid, pair, rule, fromIso, toIso);
  for (const s of sigs) if (s.side === "BUY" || s.side === "SELL") markers.push({ time: snap(s.bar_time), kind: "signal", side: s.side, label: "条件成立" });
  markers.sort((a, b) => a.time - b.time);

  const res: ChartResponse = {
    pair, timeframe: tf, rule, from, to, candles, stored_range: { from: range?.lo ?? null, to: range?.hi ?? null }, missing_ranges: missing,
    lines, levels, markers, insufficient,
    stats: { atr14_h1: lastAtr, adx14_h1: lastAdx, adx_required: rule === "rule_a" ? 25 : null },
  };
  return c.json(res);
});

routes.get("/positions", async (c) => {
  const uid = c.get("user").id;
  const state = await loadState(c.env, uid);
  const open = await all<TradeRow>(c.env.DB, "SELECT id,rule,pair,side,ticket,open_at,close_at,open_price,close_price,lots,sl,tp,pnl_usd,r_multiple,status FROM fx_trades WHERE user_id=? AND status='open' ORDER BY open_at DESC", uid);
  return c.json({ connector_online: state.online, last_seen: state.received_at, equity: state.payload?.equity ?? null, account: state.payload?.account ?? null, connector_positions: state.payload?.positions ?? [], trades: open });
});

routes.get("/trades", async (c) => {
  const uid = c.get("user").id;
  const status = c.req.query("status");
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200)));
  const where = status === "open" || status === "closed" ? "AND status=?" : "";
  const params: unknown[] = [uid]; if (where) params.push(status);
  const rows = await all<TradeRow>(c.env.DB, `SELECT id,rule,pair,side,ticket,open_at,close_at,open_price,close_price,lots,sl,tp,pnl_usd,r_multiple,status FROM fx_trades WHERE user_id=? ${where} ORDER BY COALESCE(close_at, open_at) DESC LIMIT ?`, ...params, limit);
  return c.json({ trades: rows });
});

routes.get("/performance", async (c) => {
  const uid = c.get("user").id;
  const rows = await all<{ rule: Rule; pair: string; close_at: string; r: number | null; pnl: number | null }>(c.env.DB,
    "SELECT rule,pair,close_at,r_multiple r,pnl_usd pnl FROM fx_trades WHERE user_id=? AND status='closed' AND close_at IS NOT NULL AND rule IN ('rule_a','donchian4','donchian6')", uid);
  const agg = <K extends string>(keyOf: (r: typeof rows[number]) => K) => {
    const m = new Map<K, { trades: number; wins: number; r_total: number; pnl_usd: number }>();
    for (const r of rows) { const k = keyOf(r); const e = m.get(k) ?? { trades: 0, wins: 0, r_total: 0, pnl_usd: 0 }; e.trades++; if ((r.pnl ?? 0) > 0) e.wins++; e.r_total += r.r ?? 0; e.pnl_usd += r.pnl ?? 0; m.set(k, e); }
    return m;
  };
  const byRule = agg((r) => r.rule); const byPair = agg((r) => r.pair); const byMonth = agg((r) => `${r.close_at.slice(0, 7)}|${r.rule}`);
  const rd = (n: number) => Math.round(n * 100) / 100;
  const res: PerformanceResponse = {
    note: "現行3ルールの実取引（確定分）だけを集計。過去検証のPF・勝率や旧ルールの仮想成績は含めません。",
    by_rule: RULE_KEYS.map((rule) => ({ rule, ...(byRule.get(rule) ?? { trades: 0, wins: 0, r_total: 0, pnl_usd: 0 }) })).map((x) => ({ ...x, r_total: rd(x.r_total), pnl_usd: rd(x.pnl_usd) })),
    by_pair: [...byPair.entries()].map(([pair, v]) => ({ pair, ...v, r_total: rd(v.r_total), pnl_usd: rd(v.pnl_usd) })).sort((a, b) => a.pair.localeCompare(b.pair)),
    by_month: [...byMonth.entries()].map(([k, v]) => { const [month, rule] = k.split("|") as [string, Rule]; return { month, rule, trades: v.trades, r_total: rd(v.r_total), pnl_usd: rd(v.pnl_usd) }; }).sort((a, b) => b.month.localeCompare(a.month) || a.rule.localeCompare(b.rule)),
  };
  return c.json(res);
});

routes.get("/settings", async (c) => c.json(await loadSettings(c.env, c.get("user").id)));
routes.put("/settings", async (c) => {
  const body = settingsZ.parse(await c.req.json());
  await setSetting(c.env, c.get("user").id, "fx_settings", body);
  return c.json(body);
});

routes.get("/status", async (c) => {
  const uid = c.get("user").id;
  const [settings, state] = await Promise.all([loadSettings(c.env, uid), loadState(c.env, uid)]);
  const block = await rBlock(c.env, uid, settings);
  const openPos = await one<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM fx_trades WHERE user_id=? AND status='open'", uid);
  const terminal = state.payload?.terminal_id ?? null;
  const res: StatusResponse = {
    connector_online: state.online, last_seen: state.received_at, version: state.payload?.version ?? null, account: state.payload?.account ?? null,
    equity: state.payload?.equity ?? null, mt5_connected: state.payload?.mt5_connected ?? null, lease: await leaseInfo(c.env, terminal), terminal_id: terminal,
    r_limit_block: block, year_config_valid_until: YEAR_CONFIG_VALID_UNTIL, year_config_valid: yearConfigValid(Date.now()),
    connector_stop_reasons: state.payload?.stop_reasons ?? [], open_positions: openPos?.n ?? 0, token_configured: Boolean(c.env.FX_CONNECTOR_TOKEN),
  };
  return c.json(res);
});

routes.get("/install", async (c) => {
  const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
  const markdown = `# Windowsコネクターのインストール

1. Python 3.11 以上と MetaTrader 5（XM）をWindowsにインストールし、MT5にログインしておきます。
2. コネクター一式（\`connector/\` フォルダー）をWindowsへコピーします。
3. \`pip install requests MetaTrader5\` を実行します。
4. 下の「かんたん更新・インストール」で zip をダウンロードし、任意のフォルダーに展開します（\`lifeos_connector.ini\` に接続先とトークンが入っています）。
5. \`install.bat\`（pip install）→ \`check.bat\` で接続確認（注文は出しません）。
6. \`run.bat\` で常駐させます。5秒ごとに許可を同期し、30秒リースを更新します。更新時は同じフォルダーに zip を上書き展開します（自分用の設定 \`lifeos_connector.local.ini\` と台帳 \`state/\` は zip に含まれないので残ります）。

接続トークンや口座番号をチャットやメールへ貼り付けないでください。更新時は同じフォルダーへ上書きし、台帳（state/*.json）は削除しないでください。
`;
  return c.json({
    markdown,
    endpoints: {
      heartbeat: `${origin}/api/integrations/fx/heartbeat`, permissions: `${origin}/api/integrations/fx/permissions`, signals: `${origin}/api/integrations/fx/signals`,
      trades: `${origin}/api/integrations/fx/trades`, candles: `${origin}/api/integrations/fx/candles`, quotes: `${origin}/api/integrations/fx/quotes`,
    },
    downloads: [
      { label: "かんたん更新・インストール (Windows)", url: c.env.FX_CONNECTOR_TOKEN ? "/api/fx/install/download" : null, note: c.env.FX_CONNECTOR_TOKEN ? "接続設定済みの zip。展開して install.bat → check.bat の順に実行" : "サーバーの FX_CONNECTOR_TOKEN が未設定です" },
      { label: "診断用ファイル", url: "/api/fx/install/diagnostics", note: "接続状態・最近の受信・設定を JSON で保存（トークンは含みません）" },
    ],
    token_configured: Boolean(c.env.FX_CONNECTOR_TOKEN),
  });
});

/** Every Python module the connector needs (connector/*.py, tests and the fake broker excluded). */
const CONNECTOR_MODULES: Record<string, string> = {
  "lifeos_connector.py": connectorPy, "lifeos_agent.py": agentPy, "mt5_adapter.py": mt5AdapterPy, "mt5_common.py": mt5CommonPy,
  "mt5_time.py": mt5TimePy, "rule_a_engine.py": ruleAEnginePy, "donchian_engine.py": donchianEnginePy, "donchian_v6_engine.py": donchianV6EnginePy,
  "rule_a_agent.py": ruleAAgentPy, "donchian_agent.py": donchianAgentPy, "donchian_v6_agent.py": donchianV6AgentPy, "auto_strategies.py": autoStrategiesPy,
};

/** Zip of the Windows connector with a pre-filled ini (token comes from the server secret, never shown in the UI).
 *  Updating = unzip over the folder: lifeos_connector.local.ini (own settings) and state/ (ledgers) are never in the zip. */
routes.get("/install/download", async (c) => {
  if (!c.env.FX_CONNECTOR_TOKEN) return c.json({ error: "FX_CONNECTOR_TOKEN is not configured" }, 503);
  const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
  const ini = [
    "; Life OS FXコネクターの接続設定（ダウンロード時に作成。更新のたびに上書きされます）",
    "; 口座番号・銘柄名・時刻基準などの自分用の設定は lifeos_connector.local.ini に書いてください（上書きされません）",
    "[lifeos]",
    `LIFEOS_BASE_URL=${origin}`,
    `FX_CONNECTOR_TOKEN=${c.env.FX_CONNECTOR_TOKEN}`,
    "TERMINAL_ID=win-home",
    "MT5_PATH=C:\\Program Files\\MetaTrader 5\\terminal64.exe",
    "; XMのサーバー時刻（夏 UTC+3 / 冬 UTC+2）。check.bat の time_basis_hint が utc なら local.ini で TIME_BASIS=utc に",
    "TIME_BASIS=xm_europe",
    "",
  ].join("\r\n");
  const bat = (body: string) => `@echo off\r\ncd /d "%~dp0"\r\n${body}\r\npause\r\n`;
  const files: Record<string, Uint8Array> = {
    ...Object.fromEntries(Object.entries(CONNECTOR_MODULES).map(([name, src]) => [`lifeos-connector/${name}`, strToU8(src)])),
    "lifeos-connector/README.md": strToU8(connectorReadme),
    "lifeos-connector/requirements.txt": strToU8(connectorRequirements),
    "lifeos-connector/lifeos_connector.ini": strToU8(ini),
    "lifeos-connector/install.bat": strToU8(bat("py -3 -m pip install -r requirements.txt")),
    "lifeos-connector/check.bat": strToU8(bat("py -3 lifeos_connector.py --check")),
    "lifeos-connector/run.bat": strToU8(bat("py -3 lifeos_connector.py")),
  };
  const zip = zipSync(files, { level: 6 });
  return new Response(zip, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="lifeos-connector-${new Date().toISOString().slice(0, 10)}.zip"`, "Cache-Control": "no-store" } });
});

/** Diagnostics bundle for support: status, recent signals/trades/events, settings. No secrets. */
routes.get("/install/diagnostics", async (c) => {
  const user = c.get("user");
  const [state, signals, trades, settings] = await Promise.all([
    one(c.env.DB, "SELECT payload_json, received_at FROM fx_connector_state WHERE user_id=?", user.id),
    all(c.env.DB, "SELECT pair,rule,side,stage,bar_time,received_at FROM fx_signals WHERE user_id=? ORDER BY received_at DESC LIMIT 50", user.id),
    all(c.env.DB, "SELECT rule,pair,side,ticket,open_at,close_at,status,pnl_usd,r_multiple FROM fx_trades WHERE user_id=? ORDER BY received_at DESC LIMIT 50", user.id),
    getSetting(c.env, user.id, "fx_settings", null),
  ]);
  const body = JSON.stringify({ generated_at: new Date().toISOString(), app_origin: c.env.APP_ORIGIN, connector_state: state, recent_signals: signals, recent_trades: trades, settings }, null, 2);
  return new Response(body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="lifeos-fx-diagnostics-${Date.now()}.json"`, "Cache-Control": "no-store" } });
});
