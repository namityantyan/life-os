import { describe, it, expect } from "vitest";
import { classifyRoyaltyMail, extractTargetMonth } from "../../worker/modules/royalty/logic";

describe("classifyRoyaltyMail", () => {
  it("NexTone 配信使用料分配明細公開のお知らせ is a target", () => {
    const r = classifyRoyaltyMail({ from: "info@nex-tone.co.jp", subject: "【NexTone】配信使用料分配明細公開のお知らせ" });
    expect(r).toMatchObject({ provider: "nextone", status: "target" });
  });
  it("classifies each provider from sender", () => {
    expect(classifyRoyaltyMail({ from: "noreply@d-coret.jp", subject: "2026年3月分 支払明細のご案内" }).provider).toBe("dcoret");
    expect(classifyRoyaltyMail({ from: "system@mcjp.jp", subject: "分配明細を公開しました" }).provider).toBe("mcjp");
    expect(classifyRoyaltyMail({ from: "statements@rights.services", subject: "Royalty statement available" }).provider).toBe("rights_services");
    expect(classifyRoyaltyMail({ from: "royalty@ponycanyon.co.jp", subject: "印税精算のお知らせ" }).provider).toBe("ponycanyon");
    expect(classifyRoyaltyMail({ from: "no-reply@basemint.jp", subject: "収益分配明細" }).provider).toBe("basemint");
  });
  it("falls back to subject / body when sender is unknown", () => {
    expect(classifyRoyaltyMail({ from: "forward@me.example", subject: "Fwd: ポニーキャニオン 精算明細" })).toMatchObject({ provider: "ponycanyon", status: "target" });
    expect(classifyRoyaltyMail({ from: "forward@me.example", subject: "転送", body: "D-Coret から 2026年2月分の支払明細が届きました" })).toMatchObject({ provider: "dcoret", status: "target" });
  });
  it("marks known provider without statement words as review", () => {
    expect(classifyRoyaltyMail({ from: "info@nex-tone.co.jp", subject: "システムメンテナンスのお知らせ" })).toMatchObject({ provider: "nextone", status: "review" });
  });
  it("marks unknown provider with statement words as review", () => {
    expect(classifyRoyaltyMail({ from: "someone@label.example", subject: "印税明細を送ります" })).toMatchObject({ provider: "unknown", status: "review" });
  });
  it("excludes everyday purchase receipts", () => {
    expect(classifyRoyaltyMail({ from: "noreply@starbucks.co.jp", subject: "Starbucks ご利用明細" }).status).toBe("excluded");
    expect(classifyRoyaltyMail({ from: "googleplay-noreply@google.com", subject: "Google Play のご注文の領収書" }).status).toBe("excluded");
    expect(classifyRoyaltyMail({ from: "no-reply@amazon.co.jp", subject: "ご注文の確認" }).status).toBe("excluded");
    expect(classifyRoyaltyMail({ from: "news@shop.example", subject: "メルマガ: 今週のセール" }).status).toBe("excluded");
  });
  it("excludes unrelated mail", () => {
    expect(classifyRoyaltyMail({ from: "a@b.example", subject: "打ち合わせの件" }).status).toBe("excluded");
  });
});

describe("extractTargetMonth", () => {
  it("parses 年月", () => { expect(extractTargetMonth("2026年3月分 明細")).toBe("2026-03"); expect(extractTargetMonth("2025年12月度")).toBe("2025-12"); });
  it("parses YYYY/MM and YYYY-MM", () => { expect(extractTargetMonth("明細 2026/04")).toBe("2026-04"); expect(extractTargetMonth("statement 2026-11")).toBe("2026-11"); });
  it("prefers subject, then body", () => {
    expect(extractTargetMonth("明細公開", "対象: 2026年1月")).toBe("2026-01");
    expect(extractTargetMonth("2026年2月", "2026年1月")).toBe("2026-02");
  });
  it("handles 令和", () => { expect(extractTargetMonth("令和8年3月分")).toBe("2026-03"); });
  it("returns null without a month", () => { expect(extractTargetMonth("お知らせ", "本文")).toBeNull(); expect(extractTargetMonth("2026年の集計")).toBeNull(); });
});
