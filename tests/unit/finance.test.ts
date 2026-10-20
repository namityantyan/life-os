import { describe, it, expect } from "vitest";
import { computeWithholding, computeTax, reconcilePdfTotal, aggregateMonthly, detectInvoiceMail, previousMonth, DEFAULT_MAIL_RULES } from "../../worker/modules/finance/logic";

describe("computeWithholding", () => {
  it("applies 10.21% up to 1,000,000", () => {
    expect(computeWithholding(100_000)).toBe(10_210);
    expect(computeWithholding(1_000_000)).toBe(102_100);
    expect(computeWithholding(333_333)).toBe(34_033); // 34033.3 → floor
  });
  it("applies 20.42% on the excess over 1,000,000", () => {
    expect(computeWithholding(1_500_000)).toBe(102_100 + 102_100);
    expect(computeWithholding(2_000_000)).toBe(102_100 + 204_200);
  });
  it("returns 0 for non-positive or invalid", () => {
    expect(computeWithholding(0)).toBe(0);
    expect(computeWithholding(-5)).toBe(0);
    expect(computeWithholding(NaN)).toBe(0);
  });
  it("computes 10% tax floored", () => { expect(computeTax(123_456)).toBe(12_345); });
});

describe("reconcilePdfTotal", () => {
  const inv = { amount: 100_000, tax: 10_000, withholding: 10_210, pdf_total: null as number | null };
  it("is unverified without pdf_total", () => { expect(reconcilePdfTotal(inv).status).toBe("unverified"); });
  it("matches within ±1 yen", () => {
    expect(reconcilePdfTotal({ ...inv, pdf_total: 99_790 }).status).toBe("match");
    expect(reconcilePdfTotal({ ...inv, pdf_total: 99_791 }).status).toBe("match");
    expect(reconcilePdfTotal({ ...inv, pdf_total: 99_789 }).status).toBe("match");
  });
  it("flags mismatch beyond tolerance with diff", () => {
    const r = reconcilePdfTotal({ ...inv, pdf_total: 99_800 });
    expect(r.status).toBe("mismatch"); expect(r.diff).toBe(10); expect(r.computed).toBe(99_790);
  });
});

describe("aggregateMonthly", () => {
  it("fills all 12 months for a year and sums fields", () => {
    const rows = aggregateMonthly([
      { issued_on: "2026-03-01", amount: 100_000, tax: 10_000, withholding: 10_210, pdf_total: 99_790 },
      { issued_on: "2026-03-20", amount: 50_000, tax: 5_000, withholding: 5_105, pdf_total: 60_000 },
      { issued_on: "2025-12-01", amount: 1, tax: 0, withholding: 0, pdf_total: null },
    ], 2026);
    expect(rows).toHaveLength(12);
    const mar = rows.find((r) => r.month === "2026-03")!;
    expect(mar.count).toBe(2); expect(mar.amount).toBe(150_000); expect(mar.withholding).toBe(15_315); expect(mar.mismatches).toBe(1);
    expect(rows.find((r) => r.month === "2026-01")!.count).toBe(0);
  });
});

describe("detectInvoiceMail", () => {
  it("detects invoice / receipt keywords", () => {
    expect(detectInvoiceMail("【請求書】10月分のご請求", "billing@client.co.jp")).toMatchObject({ match: true, kind: "invoice" });
    expect(detectInvoiceMail("Your receipt from Vendor", "no-reply@vendor.com")).toMatchObject({ match: true, kind: "receipt" });
    expect(detectInvoiceMail("Invoice #1234", "ap@company.com").match).toBe(true);
  });
  it("excludes newsletters and everyday purchase receipts", () => {
    expect(detectInvoiceMail("Starbucks receipt", "noreply@starbucks.co.jp").match).toBe(false);
    expect(detectInvoiceMail("Google Play のご注文の領収書", "googleplay-noreply@google.com").match).toBe(false);
    expect(detectInvoiceMail("請求書テンプレ特集 メルマガ", "news@example.com").match).toBe(false);
  });
  it("respects sender allow-list when provided", () => {
    const rules = { ...DEFAULT_MAIL_RULES, senders: ["client.co.jp"] };
    expect(detectInvoiceMail("請求書", "x@client.co.jp", rules).match).toBe(true);
    expect(detectInvoiceMail("請求書", "x@other.com", rules).match).toBe(false);
  });
  it("ignores unrelated mail", () => { expect(detectInvoiceMail("来週の打ち合わせ", "a@b.c").match).toBe(false); });
});

describe("previousMonth", () => {
  it("handles year boundary", () => { expect(previousMonth("2026-01-02")).toBe("2025-12"); expect(previousMonth("2026-03-01")).toBe("2026-02"); });
});
