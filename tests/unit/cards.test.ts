import { describe, it, expect } from "vitest";
import { monthTotal, budgetLeft, cumulativeSeries, extraSpendGuide, parseSmbcMail, parseStatementCsv } from "../../worker/modules/cards/logic";

const txs = [
  { used_at: "2026-10-01T10:00:00+09:00", amount: 1000 },
  { used_at: "2026-10-03T10:00:00+09:00", amount: 2500 },
  { used_at: "2026-10-03T12:00:00+09:00", amount: 500, status: "cancelled" },
  { used_at: "2026-09-30T10:00:00+09:00", amount: 9999 },
];

describe("totals", () => {
  it("sums the month excluding cancelled", () => { expect(monthTotal(txs, "2026-10")).toBe(3500); expect(budgetLeft(10000, 3500)).toBe(6500); expect(budgetLeft(null, 1)).toBeNull(); });
  it("cumulative series covers 1st..today only (usage period)", () => {
    const s = cumulativeSeries(txs, "2026-10", "2026-10-05");
    expect(s.length).toBe(5);
    expect(s[0]).toEqual({ date: "2026-10-01", cumulative: 1000 });
    expect(s[4]).toEqual({ date: "2026-10-05", cumulative: 3500 });
    expect(cumulativeSeries(txs, "2026-09", "2026-10-05").length).toBe(30);
  });
});

describe("extraSpendGuide", () => {
  const base = { cash: 1_000_000, cashFresh: true, reserve: 300_000, unpaidConfirmed: 120_000, notifiedTotal: 100_000, budgetLeft: 80_000, nextBonusDate: null, today: "2026-10-21" };
  it("3-step rule: (cash−reserve−unpaid) → prorate → min with budget left", () => {
    const g = extraSpendGuide(base);
    expect(g).toMatchObject({ undetermined: false, cash_cap: 580_000, amount: 80_000, months_to_bonus: 1 });
    const g2 = extraSpendGuide({ ...base, nextBonusDate: "2026-12-20", budgetLeft: 500_000 });
    expect(g2).toMatchObject({ undetermined: false, months_to_bonus: 2, cash_cap: 290_000, amount: 290_000 });
  });
  it("undetermined: unpaid unconfirmed / unpaid < notified / cash stale / no cash / no budget", () => {
    expect(extraSpendGuide({ ...base, unpaidConfirmed: null })).toMatchObject({ undetermined: true, reason: expect.stringContaining("未確認") });
    expect(extraSpendGuide({ ...base, unpaidConfirmed: 50_000 })).toMatchObject({ undetermined: true, reason: expect.stringContaining("小さい") });
    expect(extraSpendGuide({ ...base, cashFresh: false })).toMatchObject({ undetermined: true, reason: expect.stringContaining("古い") });
    expect(extraSpendGuide({ ...base, cash: null })).toMatchObject({ undetermined: true });
    expect(extraSpendGuide({ ...base, budgetLeft: null })).toMatchObject({ undetermined: true, reason: expect.stringContaining("予算") });
  });
  it("never negative", () => { expect(extraSpendGuide({ ...base, cash: 100 })).toMatchObject({ undetermined: false, amount: 0 }); });
});

describe("parseSmbcMail", () => {
  it("extracts date/time, merchant, amount from 三井住友カード mail", () => {
    const body = "なみ 様\n\nいつも三井住友カードをご利用いただきありがとうございます。\n\n◇ご利用日時：2026/10/20 12:34\n◇ご利用先：AMAZON.CO.JP\n◇ご利用金額：1,234円\n\n※本メールは承認時点の速報です。";
    expect(parseSmbcMail("【三井住友カード】ご利用のお知らせ", body)).toEqual({ used_at: "2026-10-20T12:34:00+09:00", merchant: "AMAZON.CO.JP", amount: 1234 });
  });
  it("handles full-width digits, date-only, missing merchant; returns null when no amount", () => {
    expect(parseSmbcMail("ご利用のお知らせ", "ご利用日：２０２６年１０月２日\nご利用金額：３，０００円")).toEqual({ used_at: "2026-10-02T00:00:00+09:00", merchant: null, amount: 3000 });
    expect(parseSmbcMail("ご利用のお知らせ", "本文なし")).toBeNull();
  });
});

describe("parseStatementCsv", () => {
  it("accepts when lines sum equals total row", () => {
    const p = parseStatementCsv("ご利用日,ご利用先,ご利用金額\n2026/09/01,コンビニ,\"1,500\"\n2026/09/02,スーパー,2500\n合計,,\"4,000\"\n");
    expect(p.valid).toBe(true); expect(p.total).toBe(4000); expect(p.lines).toHaveLength(2); expect(p.lines[0]).toEqual({ used_at: "2026-09-01", merchant: "コンビニ", amount: 1500 });
  });
  it("rejects mismatch and missing total", () => {
    expect(parseStatementCsv("2026/09/01,A,100\n2026/09/02,B,200\n合計,,999\n")).toMatchObject({ valid: false, errors: [expect.stringContaining("一致しません")] });
    expect(parseStatementCsv("2026/09/01,A,100\n")).toMatchObject({ valid: false, errors: [expect.stringContaining("合計行")] });
  });
});
