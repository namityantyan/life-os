import { describe, it, expect } from "vitest";
import { isStale, fillFromPrevious, freshPersonalCash, computeAllocation, computeJpy, parseBalanceCsv, toCsv } from "../../worker/modules/assets/logic";
import type { AssetPlan } from "../../shared/assets";

const today = "2026-10-21";
const plan: AssetPlan = { living_cost_monthly: 200000, planned_expenses: [{ label: "税金", amount: 100000 }], debts: [{ label: "ローン", amount: 50000 }], reserve_amount: 300000, income_next: null };
const acc = (over: Partial<{ owner_type: "personal" | "corporate"; category: any; currency: string; archived_at: string | null }> = {}) => ({ owner_type: "personal" as const, category: "bank", currency: "JPY", archived_at: null, ...over });

describe("stale detection", () => {
  it("treats >2 days as stale, ≤2 days as fresh, missing as stale", () => {
    expect(isStale("2026-10-21", today)).toBe(false);
    expect(isStale("2026-10-19", today)).toBe(false);
    expect(isStale("2026-10-18", today)).toBe(true);
    expect(isStale(null, today)).toBe(true);
  });
});

describe("fillFromPrevious", () => {
  it("fills only empty fields; keeps explicit 0", () => {
    const out = fillFromPrevious(
      [{ account_id: "a", quantity: null }, { account_id: "b", quantity: 0 }, { account_id: "c", quantity: 10 }, { account_id: "d", quantity: null }],
      { a: { quantity: 500, rate: null, jpy_value: 500 }, b: { quantity: 999, rate: null, jpy_value: 999 }, c: { quantity: 1, rate: null, jpy_value: 1 } },
    );
    expect(out.map((e) => e.quantity)).toEqual([500, 0, 10, null]);
    expect(out[0].jpy_value).toBe(500);
  });
});

describe("allocation", () => {
  it("excludes corporate and volatile categories and computes protect/spend/invest", () => {
    const cash = freshPersonalCash([
      { account: acc(), recorded_on: today, jpy_value: 1_000_000 },
      { account: acc({ owner_type: "corporate" }), recorded_on: today, jpy_value: 5_000_000 },
      { account: acc({ category: "securities" }), recorded_on: today, jpy_value: 2_000_000 },
      { account: acc({ currency: "USD" }), recorded_on: today, jpy_value: 300_000 },
    ], today);
    expect(cash.amount).toBe(1_000_000);
    const a = computeAllocation(cash, plan, today);
    expect(a.undetermined).toBe(false);
    if (!a.undetermined) { expect(a.protect).toBe(650000); expect(a.spend).toBe(200000); expect(a.invest).toBe(150000); }
  });
  it("prorates living cost until next income", () => {
    const a = computeAllocation({ amount: 2_000_000, as_of: today }, { ...plan, income_next: { date: "2026-12-25", amount: 500000 } }, today);
    if (!a.undetermined) { expect(a.breakdown.living_months).toBe(3); expect(a.protect).toBe(600000 + 450000); }
  });
  it("is undetermined when cash is stale, unknown, or missing", () => {
    expect(computeAllocation(freshPersonalCash([{ account: acc(), recorded_on: "2026-10-10", jpy_value: 1 }], today), plan, today)).toMatchObject({ undetermined: true });
    expect(computeAllocation(freshPersonalCash([{ account: acc(), recorded_on: today, jpy_value: null }], today), plan, today)).toMatchObject({ undetermined: true });
    expect(computeAllocation(freshPersonalCash([], today), plan, today)).toMatchObject({ undetermined: true });
    expect(computeAllocation({ amount: 100, as_of: today }, { ...plan, living_cost_monthly: null }, today)).toMatchObject({ undetermined: true, reason: expect.stringContaining("生活費") });
  });
  it("never produces negative spend/invest", () => {
    const a = computeAllocation({ amount: 100_000, as_of: today }, plan, today);
    if (!a.undetermined) { expect(a.spend).toBe(0); expect(a.invest).toBe(0); }
  });
});

describe("jpy value", () => {
  it("uses quantity×rate for non-JPY, quantity for JPY, null when unknown", () => {
    expect(computeJpy("JPY", 100, null)).toBe(100);
    expect(computeJpy("USD", 10, 150)).toBe(1500);
    expect(computeJpy("USD", 10, null)).toBeNull();
    expect(computeJpy("BTC", null, 1)).toBeNull();
    expect(computeJpy("USD", 10, null, 1600)).toBe(1600);
  });
});

describe("CSV", () => {
  it("parses header, quoted names, slashes dates, empty = unknown, reports bad rows", () => {
    const { rows, errors } = parseBalanceCsv('date,account,quantity,rate,jpy_value\n2026/10/01,"銀行, A",1000,,\n2026-10-02,USD口座,10,150,1500\nbad,x,1\n2026-10-03,,1\n');
    expect(rows).toEqual([
      { date: "2026-10-01", account: "銀行, A", quantity: 1000, rate: null, jpy_value: null },
      { date: "2026-10-02", account: "USD口座", quantity: 10, rate: 150, jpy_value: 1500 },
    ]);
    expect(errors).toHaveLength(2);
  });
  it("round-trips through toCsv", () => {
    const rows = [{ date: "2026-10-01", account: "a,b", quantity: 1, rate: null, jpy_value: 1 }];
    expect(parseBalanceCsv(toCsv(rows)).rows).toEqual(rows);
  });
});
