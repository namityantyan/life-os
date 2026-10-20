// Pure FX logic (no D1). Unit tested in tests/unit/fx.test.ts.
// Numbers come from docs/SPEC.md §11 and life-bot/docs/fx-*.md. The server never places orders;
// these helpers compute marks, limits and reference levels for display and for the connector contract.
import {
  CONNECTOR_STALE_MS, SIGNAL_STALE_MS, YEAR_CONFIG_VALID_UNTIL, pipSize,
  type CandleBar, type Rule, type SetupMark, type Side, type SignalPayload, type RLimits,
} from "@shared/fx";

const toMs = (v: string | number | Date | null | undefined): number | null => {
  if (v == null) return null;
  const n = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

/* ---------------------------------------------------------------- marks */
/** Judgment bar length per rule: A = H1, donchian = H4. */
export const JUDGE_BAR_MS: Record<Rule, number> = { rule_a: 3600_000, donchian4: 14_400_000, donchian6: 14_400_000 };
export type SignalLike = Pick<SignalPayload, "rule" | "side" | "stage" | "bar_time"> & { received_at?: string | null };

/**
 * Setup mark for one pair/rule. Staleness wins over everything: a silent connector (>45 s) or an
 * old judgment bar (rule A > 90 min, donchian > 5 h) clears the highlight and shows 更新待ち.
 */
export function setupMarkFor(signal: SignalLike | null, now: Date | number | string, connectorLastSeen: Date | number | string | null): SetupMark {
  const nowMs = toMs(now) ?? Date.now();
  const seen = toMs(connectorLastSeen);
  if (seen == null || nowMs - seen > CONNECTOR_STALE_MS) return { kind: "stale", label: "更新待ち", side: null, bar_time: signal?.bar_time ?? null, reason: "connector_offline" };
  if (!signal) return { kind: "stale", label: "更新待ち", side: null, bar_time: null, reason: "no_signal" };
  const bar = toMs(signal.bar_time);
  // bar_time is the bar's open (MT5 convention); the judgment happens at its close, so staleness is measured from close.
  const closeMs = bar == null ? null : bar + JUDGE_BAR_MS[signal.rule];
  if (closeMs == null || nowMs - closeMs > SIGNAL_STALE_MS[signal.rule]) return { kind: "stale", label: "更新待ち", side: null, bar_time: signal.bar_time, reason: "bar_too_old" };
  if (bar != null && bar - nowMs > 5 * 60_000) return { kind: "stale", label: "更新待ち", side: null, bar_time: signal.bar_time, reason: "bar_in_future" };
  const side = signal.side;
  if (signal.stage === "entry" && side) return { kind: side === "BUY" ? "entry_buy" : "entry_sell", label: `◆ 条件成立 · ${side}`, side, bar_time: signal.bar_time, reason: null };
  if (signal.stage === "setup" && side) return { kind: side === "BUY" ? "ready_buy" : "ready_sell", label: `✓ 準備OK · ${side}`, side, bar_time: signal.bar_time, reason: null };
  return { kind: "waiting", label: "準備待ち", side: null, bar_time: signal.bar_time, reason: null };
}

/* ------------------------------------------------------------- R limits */
export type RealizedTrade = { close_at: string | null; r_multiple: number | null; status?: string };
export const DEFAULT_R_LIMITS: RLimits = { day: -2, week: -3, month: -2 };

const utcDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcMonthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** ISO-like week key: Monday 00:00 UTC start. */
export function utcWeekStart(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400_000;
}

/** Sum realized R of the three live rules per UTC day / Monday-start week / month and block at −2R/−3R/−2R. */
export function rLimitsBlockNewEntries(trades: RealizedTrade[], nowUtc: Date | number | string, limits: RLimits = DEFAULT_R_LIMITS) {
  const nowMs = toMs(nowUtc) ?? Date.now();
  const day = utcDayKey(nowMs), month = utcMonthKey(nowMs), week = utcWeekStart(nowMs);
  let day_r = 0, week_r = 0, month_r = 0;
  for (const t of trades) {
    if (t.status && t.status !== "closed") continue;
    const c = toMs(t.close_at); if (c == null || t.r_multiple == null || !Number.isFinite(t.r_multiple)) continue;
    if (c > nowMs) continue;
    if (utcDayKey(c) === day) day_r += t.r_multiple;
    if (utcWeekStart(c) === week) week_r += t.r_multiple;
    if (utcMonthKey(c) === month) month_r += t.r_multiple;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  let reason: string | null = null;
  if (day_r <= limits.day) reason = `日次 ${r(day_r)}R ≤ ${limits.day}R`;
  else if (week_r <= limits.week) reason = `週次 ${r(week_r)}R ≤ ${limits.week}R`;
  else if (month_r <= limits.month) reason = `月次 ${r(month_r)}R ≤ ${limits.month}R`;
  return { blocked: reason != null, reason, day_r: r(day_r), week_r: r(week_r), month_r: r(month_r) };
}

/* ----------------------------------------------------------------- SL/TP */
export const COST_PIPS = 1.2; // 手数料0.2 + 追加費用1.0
export type SlTpInput = { lastLows5?: number[]; lastHighs5?: number[]; atr14: number; closeH1: number; multiplier: number; entryPrice?: number; pip: number };
export type SlTpResult = { origin: number; slDistance: number; sl: number; tpDistance: number; tp: number; slPips: number; tpPips: number };

const round = (v: number, pip: number) => Math.round(v / (pip / 10)) * (pip / 10); // broker digit (pipette)

/** Buy: origin = min(min(low5) − 0.1·ATR, close − 0.5·ATR); SL距離 = multiplier × (entry − origin); TP距離 = 3×SL距離 + 4×1.2 pips. */
export function slTpForBuy(i: SlTpInput): SlTpResult {
  const lows = i.lastLows5 ?? [];
  if (lows.length === 0) throw new Error("lastLows5 required");
  const origin = Math.min(Math.min(...lows) - 0.1 * i.atr14, i.closeH1 - 0.5 * i.atr14);
  const entry = i.entryPrice ?? i.closeH1;
  const slDistance = i.multiplier * (entry - origin);
  const tpDistance = 3 * slDistance + 4 * COST_PIPS * i.pip;
  const sl = round(entry - slDistance, i.pip), tp = round(entry + tpDistance, i.pip);
  return { origin, slDistance, sl, tpDistance, tp, slPips: slDistance / i.pip, tpPips: tpDistance / i.pip };
}
/** Sell mirror: origin = max(max(high5) + 0.1·ATR, close + 0.5·ATR). */
export function slTpForSell(i: SlTpInput): SlTpResult {
  const highs = i.lastHighs5 ?? [];
  if (highs.length === 0) throw new Error("lastHighs5 required");
  const origin = Math.max(Math.max(...highs) + 0.1 * i.atr14, i.closeH1 + 0.5 * i.atr14);
  const entry = i.entryPrice ?? i.closeH1;
  const slDistance = i.multiplier * (origin - entry);
  const tpDistance = 3 * slDistance + 4 * COST_PIPS * i.pip;
  const sl = round(entry + slDistance, i.pip), tp = round(entry - tpDistance, i.pip);
  return { origin, slDistance, sl, tpDistance, tp, slPips: slDistance / i.pip, tpPips: tpDistance / i.pip };
}
export const slTpFor = (side: Side, i: SlTpInput) => (side === "BUY" ? slTpForBuy(i) : slTpForSell(i));
export const SL_MULTIPLIER: Record<Rule, number> = { rule_a: 0.5, donchian4: 1, donchian6: 1 };

/* ------------------------------------------------------------ lot sizing */
/**
 * ドンチャン改良6: lots such that (SL loss + cost) ≤ riskUsd, rounded DOWN to lotStep.
 * pipValueUsd = USD value of 1 pip for 1.0 lot; costUsd = USD cost of 1.2 pips for 1.0 lot (default derived from pipValueUsd).
 * Returns null when even the minimum lot exceeds the budget (do not order).
 */
export function lotForDonchian6(riskUsd: number = 60, slPips: number, pipValueUsd: number, costUsd?: number, opts: { lotStep?: number; minLot?: number; maxLot?: number } = {}): number | null {
  const step = opts.lotStep ?? 0.01, minLot = opts.minLot ?? 0.01, maxLot = opts.maxLot ?? 50;
  if (!(slPips > 0) || !(pipValueUsd > 0) || !(riskUsd > 0)) return null;
  const cost = costUsd ?? COST_PIPS * pipValueUsd;
  const perLot = slPips * pipValueUsd + cost;
  const raw = riskUsd / perLot;
  const lots = Math.floor(raw / step + 1e-9) * step;
  const rounded = Math.round(lots / step) * step;
  const final = Math.min(Math.round(rounded * 100) / 100, maxLot);
  if (final < minLot) return null;
  if (final * perLot > riskUsd + 1e-9) return null; // final budget check at chosen size
  return final;
}

/* ------------------------------------------------------- holding deadline */
const JST_OFFSET_MS = 9 * 3600_000;
/** Next 05:00 JST strictly after `ms`. */
export function nextJst0500(ms: number): number {
  const jst = ms + JST_OFFSET_MS;
  const dayStart = Math.floor(jst / 86400_000) * 86400_000;
  let candidate = dayStart + 5 * 3600_000;
  if (candidate <= jst) candidate += 86400_000;
  return candidate - JST_OFFSET_MS;
}
/** Next Saturday 05:00 JST strictly after `ms`. */
export function nextSaturdayJst0500(ms: number): number {
  let c = nextJst0500(ms);
  for (let i = 0; i < 8; i++) {
    if (new Date(c + JST_OFFSET_MS).getUTCDay() === 6) return c;
    c += 86400_000;
  }
  return c;
}
/** A: min(open+18h, next 05:00 JST). Donchian: min(open+48h, next Saturday 05:00 JST). */
export function holdingDeadline(rule: Rule, openAtUtc: Date | number | string): Date {
  const ms = toMs(openAtUtc);
  if (ms == null) throw new Error("invalid openAt");
  if (rule === "rule_a") return new Date(Math.min(ms + 18 * 3600_000, nextJst0500(ms)));
  return new Date(Math.min(ms + 48 * 3600_000, nextSaturdayJst0500(ms)));
}

/* -------------------------------------------------------------- indicators */
/** Simple moving average; null until `period` values are available. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
export function trueRanges(bars: CandleBar[]): number[] {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1]!.c), Math.abs(b.l - bars[i - 1]!.c))));
}
/** ATR as the simple mean of the last `period` true ranges (MT5 iATR convention). */
export function atr(bars: CandleBar[], period = 14): (number | null)[] {
  return sma(trueRanges(bars), period);
}
/** Wilder ADX(period). Returns null until enough bars (2×period) exist. */
export function adx(bars: CandleBar[], period = 14): (number | null)[] {
  const n = bars.length; const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;
  const tr = trueRanges(bars);
  const plusDM: number[] = [0], minusDM: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i]!.h - bars[i - 1]!.h, down = bars[i - 1]!.l - bars[i]!.l;
    plusDM.push(up > down && up > 0 ? up : 0); minusDM.push(down > up && down > 0 ? down : 0);
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i <= period; i++) { sTR += tr[i]!; sP += plusDM[i]!; sM += minusDM[i]!; }
  const dx: number[] = [];
  const pushDx = () => { const pdi = sTR ? (100 * sP) / sTR : 0, mdi = sTR ? (100 * sM) / sTR : 0; const s = pdi + mdi; dx.push(s ? (100 * Math.abs(pdi - mdi)) / s : 0); };
  pushDx();
  for (let i = period + 1; i < n; i++) {
    sTR = sTR - sTR / period + tr[i]!; sP = sP - sP / period + plusDM[i]!; sM = sM - sM / period + minusDM[i]!;
    pushDx();
  }
  // dx[k] corresponds to bar index period + k
  let adxVal: number | null = null;
  for (let k = 0; k < dx.length; k++) {
    const idx = period + k;
    if (k === period - 1) { adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period; }
    else if (k >= period) { adxVal = ((adxVal as number) * (period - 1) + dx[k]!) / period; }
    if (adxVal != null && k >= period - 1) out[idx] = adxVal;
  }
  return out;
}
/** Slope sign: compare SMA now against `lookback` bars ago. */
export function slopeUp(series: (number | null)[], i: number, lookback: number): boolean | null {
  const a = series[i], b = series[i - lookback];
  if (a == null || b == null) return null;
  return a > b;
}

/* -------------------------------------------------------------- pivots */
export type Pivots = { P: number; R1: number; R2: number; R3: number; S1: number; S2: number; S3: number };
/** Classic daily pivots from one completed D1 bar: P=(H+L+C)/3, R1=2P−L, S1=2P−H, R2=P+(H−L), S2=P−(H−L), R3=H+2(P−L), S3=L−2(H−P). */
export function dailyPivots(d1: Pick<CandleBar, "h" | "l" | "c">): Pivots {
  const P = (d1.h + d1.l + d1.c) / 3, range = d1.h - d1.l;
  return { P, R1: 2 * P - d1.l, S1: 2 * P - d1.h, R2: P + range, S2: P - range, R3: d1.h + 2 * (P - d1.l), S3: d1.l - 2 * (d1.h - P) };
}
/** ドンチャン改良6 day bucket: days start at JST 06:00 (= UTC 21:00 of the previous calendar day). Returns bucket start unix seconds. */
export function jst06DayBucket(unixSec: number): number {
  const shift = 21 * 3600; // UTC21:00 boundary
  return Math.floor((unixSec - shift) / 86400) * 86400 + shift;
}
/** Aggregate observed H1 bars into JST06:00-bucketed daily bars. Buckets whose first H1 is not the bucket start are dropped (partial day at the head); no price interpolation. */
export function aggregateDailyJst06(h1: CandleBar[]): CandleBar[] {
  const map = new Map<number, { bar: CandleBar; firstT: number }>();
  for (const b of [...h1].sort((a, b) => a.t - b.t)) {
    const k = jst06DayBucket(b.t);
    const e = map.get(k);
    if (!e) map.set(k, { bar: { t: k, o: b.o, h: b.h, l: b.l, c: b.c }, firstT: b.t });
    else { e.bar.h = Math.max(e.bar.h, b.h); e.bar.l = Math.min(e.bar.l, b.l); e.bar.c = b.c; }
  }
  const out: CandleBar[] = [];
  const keys = [...map.keys()].sort((a, b) => a - b);
  keys.forEach((k, i) => { const e = map.get(k)!; if (i === 0 && e.firstT !== k) return; out.push(e.bar); });
  return out;
}

/* ----------------------------------------------------------- misc helpers */
export const yearConfigValid = (now: Date | number | string, until = YEAR_CONFIG_VALID_UNTIL) => (toMs(now) ?? Date.now()) < Date.parse(`${until}T00:00:00Z`);

/** Gaps in a bar sequence larger than 2 intervals, excluding the weekend closure (Fri 21:00 UTC → Sun 21:00 UTC). */
export function missingRanges(bars: CandleBar[], tfSec: number, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const isWeekendGap = (a: number, b: number) => {
    const da = new Date(a * 1000), db = new Date(b * 1000);
    const fri = da.getUTCDay() === 5 && da.getUTCHours() >= 20, sun = db.getUTCDay() === 0 && db.getUTCHours() >= 20, mon = db.getUTCDay() === 1 && db.getUTCHours() <= 1;
    return fri && (sun || mon) && b - a <= 3 * 86400;
  };
  if (bars.length === 0) return [{ from, to }];
  if (bars[0]!.t - from > 2 * tfSec) out.push({ from, to: bars[0]!.t });
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]!.t, b = bars[i]!.t;
    if (b - a > 2 * tfSec && !isWeekendGap(a + tfSec, b)) out.push({ from: a + tfSec, to: b });
  }
  const last = bars[bars.length - 1]!.t;
  if (to - last > 2 * tfSec) out.push({ from: last + tfSec, to });
  return out;
}

export const pipsBetween = (pair: string, a: number, b: number) => Math.abs(a - b) / pipSize(pair);
