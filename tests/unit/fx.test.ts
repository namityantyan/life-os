import { describe, it, expect } from "vitest";
import {
  setupMarkFor, rLimitsBlockNewEntries, slTpForBuy, slTpForSell, lotForDonchian6, holdingDeadline, nextJst0500, nextSaturdayJst0500,
  sma, atr, adx, dailyPivots, jst06DayBucket, aggregateDailyJst06, missingRanges, yearConfigValid, utcWeekStart, COST_PIPS,
} from "../../worker/modules/fx/logic";
import type { CandleBar } from "../../shared/fx";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const min = 60_000, hour = 3600_000;

describe("setupMarkFor", () => {
  const seen = iso(T0 - 10_000);
  it("shows 更新待ち when the connector is silent for more than 45 s", () => {
    const sig = { rule: "rule_a" as const, side: "BUY" as const, stage: "setup" as const, bar_time: iso(T0 - 5 * min) };
    expect(setupMarkFor(sig, T0, iso(T0 - 46_000)).label).toBe("更新待ち");
    expect(setupMarkFor(sig, T0, null).label).toBe("更新待ち");
    expect(setupMarkFor(sig, T0, iso(T0 - 44_000)).label).toBe("✓ 準備OK · BUY");
  });
  it("shows 更新待ち without any signal", () => {
    expect(setupMarkFor(null, T0, seen)).toMatchObject({ kind: "stale", label: "更新待ち", reason: "no_signal" });
  });
  it("maps stages to the spec marks", () => {
    expect(setupMarkFor({ rule: "rule_a", side: "SELL", stage: "setup", bar_time: iso(T0 - 5 * min) }, T0, seen)).toMatchObject({ kind: "ready_sell", label: "✓ 準備OK · SELL" });
    expect(setupMarkFor({ rule: "donchian4", side: "BUY", stage: "entry", bar_time: iso(T0 - 5 * min) }, T0, seen)).toMatchObject({ kind: "entry_buy", label: "◆ 条件成立 · BUY" });
    expect(setupMarkFor({ rule: "donchian6", side: null, stage: "none", bar_time: iso(T0 - 5 * min) }, T0, seen)).toMatchObject({ kind: "waiting", label: "準備待ち" });
  });
  it("clears the highlight when the judgment bar is too old, measured from bar close (A: 90 min after H1 close, donchian: 5 h after H4 close)", () => {
    // bar_time is the bar open; H1 closes 60 min later, H4 240 min later
    expect(setupMarkFor({ rule: "rule_a", side: "BUY", stage: "setup", bar_time: iso(T0 - (60 + 89) * min) }, T0, seen).kind).toBe("ready_buy");
    expect(setupMarkFor({ rule: "rule_a", side: "BUY", stage: "setup", bar_time: iso(T0 - (60 + 91) * min) }, T0, seen)).toMatchObject({ kind: "stale", reason: "bar_too_old" });
    expect(setupMarkFor({ rule: "donchian4", side: "BUY", stage: "setup", bar_time: iso(T0 - 4 * hour - 4.9 * hour) }, T0, seen).kind).toBe("ready_buy");
    expect(setupMarkFor({ rule: "donchian6", side: "SELL", stage: "entry", bar_time: iso(T0 - 4 * hour - 5.1 * hour) }, T0, seen).kind).toBe("stale");
  });
});

describe("rLimitsBlockNewEntries", () => {
  const now = Date.parse("2026-10-21T10:00:00Z"); // Wednesday
  const t = (closeAt: string, r: number) => ({ close_at: closeAt, r_multiple: r, status: "closed" });
  it("blocks at −2R in a UTC day", () => {
    const res = rLimitsBlockNewEntries([t("2026-10-21T01:00:00Z", -1), t("2026-10-21T05:00:00Z", -1)], now);
    expect(res.blocked).toBe(true); expect(res.day_r).toBe(-2); expect(res.reason).toContain("日次");
  });
  it("does not block at −1.9R", () => {
    expect(rLimitsBlockNewEntries([t("2026-10-21T01:00:00Z", -1.9)], now).blocked).toBe(false);
  });
  it("uses Monday-start UTC weeks for −3R", () => {
    const res = rLimitsBlockNewEntries([t("2026-10-19T02:00:00Z", -1.5), t("2026-10-20T02:00:00Z", -1.5)], now);
    expect(res.day_r).toBe(0); expect(res.week_r).toBe(-3); expect(res.blocked).toBe(true); expect(res.reason).toContain("週次");
    // Sunday before counts for the previous week
    const prev = rLimitsBlockNewEntries([t("2026-10-18T23:00:00Z", -1.5), t("2026-10-20T02:00:00Z", -0.4)], now);
    expect(prev.week_r).toBe(-0.4); expect(prev.month_r).toBe(-1.9); expect(prev.blocked).toBe(false);
  });
  it("blocks at −2R in a UTC month across different weeks", () => {
    const res = rLimitsBlockNewEntries([t("2026-10-02T02:00:00Z", -1), t("2026-10-09T02:00:00Z", -1)], now);
    expect(res.month_r).toBe(-2); expect(res.blocked).toBe(true); expect(res.reason).toContain("月次");
  });
  it("ignores open trades, future closes and trades without R", () => {
    const res = rLimitsBlockNewEntries([
      { close_at: null, r_multiple: -5, status: "open" }, t("2026-10-21T12:00:00Z", -5), { close_at: "2026-10-21T01:00:00Z", r_multiple: null, status: "closed" },
    ], now);
    expect(res.blocked).toBe(false);
  });
  it("utcWeekStart is Monday 00:00", () => {
    expect(new Date(utcWeekStart(now)).toISOString()).toBe("2026-10-19T00:00:00.000Z");
  });
});

describe("SL/TP", () => {
  it("buy: origin = min(min(low5)−0.1ATR, close−0.5ATR), SL = 0.5× for rule A, TP = 3×SL + 4×1.2 pips", () => {
    const r = slTpForBuy({ lastLows5: [150.10, 150.05, 150.20, 150.00, 150.15], atr14: 0.40, closeH1: 150.50, multiplier: 0.5, pip: 0.01 });
    // min low 150.00 − 0.04 = 149.96; close − 0.20 = 150.30 → origin 149.96
    expect(r.origin).toBeCloseTo(149.96, 6);
    expect(r.slDistance).toBeCloseTo(0.5 * (150.50 - 149.96), 6); // 0.27
    expect(r.sl).toBeCloseTo(150.23, 6);
    expect(r.tpDistance).toBeCloseTo(3 * 0.27 + 4 * 1.2 * 0.01, 6); // 0.858
    expect(r.tp).toBeCloseTo(151.358, 6);
    expect(COST_PIPS).toBe(1.2);
  });
  it("buy: close−0.5ATR wins when lower", () => {
    const r = slTpForBuy({ lastLows5: [1.1000, 1.1010, 1.1005, 1.1020, 1.1015], atr14: 0.0100, closeH1: 1.1020, multiplier: 1, pip: 0.0001 });
    expect(r.origin).toBeCloseTo(1.0970, 8); // close − 0.005 < 1.1000 − 0.001
    expect(r.slDistance).toBeCloseTo(0.0050, 8);
    expect(r.tpDistance).toBeCloseTo(0.0150 + 4 * 1.2 * 0.0001, 8);
  });
  it("uses the actual entry price for the distance when given", () => {
    const r = slTpForBuy({ lastLows5: [150.00], atr14: 0.40, closeH1: 150.50, multiplier: 1, entryPrice: 150.55, pip: 0.01 });
    expect(r.slDistance).toBeCloseTo(150.55 - 149.96, 6);
    expect(r.sl).toBeCloseTo(149.96, 6);
  });
  it("sell mirrors: origin = max(max(high5)+0.1ATR, close+0.5ATR)", () => {
    const r = slTpForSell({ lastHighs5: [150.90, 151.00, 150.95, 150.80, 150.85], atr14: 0.40, closeH1: 150.50, multiplier: 1, pip: 0.01 });
    expect(r.origin).toBeCloseTo(151.04, 6);
    expect(r.sl).toBeCloseTo(151.04, 6);
    expect(r.tp).toBeCloseTo(150.50 - (3 * 0.54 + 0.048), 6);
  });
});

describe("lotForDonchian6", () => {
  it("rounds DOWN to 0.01 lot so that SL loss + cost ≤ 60 USD", () => {
    // 1 lot: 30 pips × 10 USD = 300 + cost 12 → 312 USD/lot → 60/312 = 0.1923 → 0.19
    expect(lotForDonchian6(60, 30, 10)).toBe(0.19);
    expect(lotForDonchian6(60, 30, 10, 12)).toBe(0.19);
  });
  it("never rounds up", () => {
    // 60 / (20×10+12) = 0.283 → 0.28
    expect(lotForDonchian6(60, 20, 10)).toBe(0.28);
    // exact: 60 / (50×10+100) = 0.1 → 0.1
    expect(lotForDonchian6(60, 50, 10, 100)).toBe(0.1);
  });
  it("returns null when the minimum lot already exceeds the budget", () => {
    expect(lotForDonchian6(60, 700, 10)).toBeNull(); // 0.01 lot = 70.12 USD > 60
    expect(lotForDonchian6(60, 0, 10)).toBeNull();
  });
  it("respects max lot", () => {
    expect(lotForDonchian6(100000, 1, 1, 0)).toBe(50);
  });
});

describe("holdingDeadline", () => {
  it("rule A: 18 h cap", () => {
    // open 2026-10-21 00:00 UTC = 09:00 JST → next 05:00 JST = 10-22 05:00 JST = 10-21 20:00 UTC (20 h) → 18 h wins
    expect(holdingDeadline("rule_a", "2026-10-21T00:00:00Z").toISOString()).toBe("2026-10-21T18:00:00.000Z");
  });
  it("rule A: next 05:00 JST wins when closer", () => {
    // open 10:00 UTC = 19:00 JST → next 05:00 JST = 20:00 UTC same day (10 h)
    expect(holdingDeadline("rule_a", "2026-10-21T10:00:00Z").toISOString()).toBe("2026-10-21T20:00:00.000Z");
    // open exactly at 05:00 JST → next day's 05:00 JST, capped at 18h
    expect(holdingDeadline("rule_a", "2026-10-20T20:00:00Z").toISOString()).toBe("2026-10-21T14:00:00.000Z");
  });
  it("donchian: 48 h or Saturday 05:00 JST (Friday 20:00 UTC)", () => {
    expect(holdingDeadline("donchian4", "2026-10-19T00:00:00Z").toISOString()).toBe("2026-10-21T00:00:00.000Z"); // Monday → 48h
    expect(holdingDeadline("donchian6", "2026-10-22T10:00:00Z").toISOString()).toBe("2026-10-23T20:00:00.000Z"); // Thursday → Sat 05:00 JST
  });
  it("nextJst0500 / nextSaturdayJst0500", () => {
    expect(new Date(nextJst0500(Date.parse("2026-10-21T19:59:00Z"))).toISOString()).toBe("2026-10-21T20:00:00.000Z");
    expect(new Date(nextJst0500(Date.parse("2026-10-21T20:00:00Z"))).toISOString()).toBe("2026-10-22T20:00:00.000Z");
    expect(new Date(nextSaturdayJst0500(Date.parse("2026-10-23T20:00:00Z"))).toISOString()).toBe("2026-10-30T20:00:00.000Z");
  });
});

const mkBars = (closes: number[], spread = 0.5): CandleBar[] => closes.map((c, i) => ({ t: 1_700_000_000 + i * 3600, o: c, h: c + spread, l: c - spread, c }));

describe("indicators", () => {
  it("sma", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("atr is the mean of the last 14 true ranges", () => {
    const bars = mkBars(Array.from({ length: 20 }, () => 100), 0.5); // TR = 1 for every bar
    const a = atr(bars, 14);
    expect(a[12]).toBeNull(); expect(a[13]).toBeCloseTo(1, 9); expect(a[19]).toBeCloseTo(1, 9);
  });
  it("adx rises in a steady trend and stays within 0..100", () => {
    const bars = mkBars(Array.from({ length: 60 }, (_, i) => 100 + i * 0.3), 0.2);
    const a = adx(bars, 14);
    expect(a[26]).toBeNull();
    const last = a[59]!; expect(last).toBeGreaterThan(25); expect(last).toBeLessThanOrEqual(100);
    // flat market → low ADX
    const flat = adx(mkBars(Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1)), 0.2), 14);
    expect(flat[59]!).toBeLessThan(25);
  });
});

describe("pivots & JST06 bucketing", () => {
  it("dailyPivots P, R1-3, S1-3", () => {
    const p = dailyPivots({ h: 152, l: 150, c: 151 });
    expect(p.P).toBeCloseTo(151); expect(p.R1).toBeCloseTo(152); expect(p.S1).toBeCloseTo(150);
    expect(p.R2).toBeCloseTo(153); expect(p.S2).toBeCloseTo(149); expect(p.R3).toBeCloseTo(154); expect(p.S3).toBeCloseTo(148);
  });
  it("jst06DayBucket starts days at UTC 21:00 (JST 06:00)", () => {
    const b = jst06DayBucket(Math.floor(Date.parse("2026-10-21T10:00:00Z") / 1000));
    expect(new Date(b * 1000).toISOString()).toBe("2026-10-20T21:00:00.000Z");
    const b2 = jst06DayBucket(Math.floor(Date.parse("2026-10-21T21:00:00Z") / 1000));
    expect(new Date(b2 * 1000).toISOString()).toBe("2026-10-21T21:00:00.000Z");
    const b3 = jst06DayBucket(Math.floor(Date.parse("2026-10-21T20:59:59Z") / 1000));
    expect(new Date(b3 * 1000).toISOString()).toBe("2026-10-20T21:00:00.000Z");
  });
  it("aggregateDailyJst06 drops a partial head day and does not interpolate", () => {
    const start = Math.floor(Date.parse("2026-10-20T23:00:00Z") / 1000); // mid-bucket start (bucket began 21:00)
    const h1: CandleBar[] = [];
    for (let i = 0; i < 48; i++) h1.push({ t: start + i * 3600, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i });
    const days = aggregateDailyJst06(h1);
    // buckets: 10-20 21:00 (partial, dropped), 10-21 21:00 (full 24), 10-22 21:00 (partial tail kept: 22 bars)
    expect(days.length).toBe(2);
    expect(new Date(days[0]!.t * 1000).toISOString()).toBe("2026-10-21T21:00:00.000Z");
    expect(days[0]!.h).toBe(101 + 45); expect(days[0]!.l).toBe(99 + 22); expect(days[0]!.o).toBe(100 + 22);
  });
});

describe("misc", () => {
  it("yearConfigValid flips on 2027-10-01", () => {
    expect(yearConfigValid("2027-09-30T23:59:59Z")).toBe(true);
    expect(yearConfigValid("2027-10-01T00:00:00Z")).toBe(false);
  });
  it("missingRanges reports gaps, ignores the weekend closure", () => {
    const tf = 300;
    const t0 = Math.floor(Date.parse("2026-10-21T00:00:00Z") / 1000);
    const bars: CandleBar[] = [];
    for (let i = 0; i < 24; i++) if (i < 10 || i >= 15) bars.push({ t: t0 + i * tf, o: 1, h: 1, l: 1, c: 1 });
    const gaps = missingRanges(bars, tf, t0, t0 + 23 * tf);
    expect(gaps).toEqual([{ from: t0 + 10 * tf, to: t0 + 15 * tf }]);
    const fri = Math.floor(Date.parse("2026-10-23T20:55:00Z") / 1000), sun = Math.floor(Date.parse("2026-10-25T21:00:00Z") / 1000);
    expect(missingRanges([{ t: fri, o: 1, h: 1, l: 1, c: 1 }, { t: sun, o: 1, h: 1, l: 1, c: 1 }], tf, fri, sun)).toEqual([]);
    expect(missingRanges([], tf, 0, 100)).toEqual([{ from: 0, to: 100 }]);
  });
});
