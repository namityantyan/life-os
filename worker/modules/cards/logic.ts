// Pure logic for the カード利用 module: totals, guide rule, SMBC mail parsing, statement CSV validation.
import type { SpendGuide } from "@shared/cards";

export type TxLike = { used_at: string; amount: number; status?: string; source?: string };
/**
 * "Usage" rows are the approval notifications (gmail) and manual entries. Statement CSV lines
 * (source 'csv') describe the closed billing and would double-count the same purchases, so they
 * never enter the month total / cumulative chart / timeline.
 */
export const isUsage = (t: TxLike) => t.status !== "cancelled" && t.source !== "csv";
const active = isUsage;

/** Sum of non-cancelled usage (non-CSV) transactions in YYYY-MM (used_at in JST ISO or date). */
export function monthTotal(txs: TxLike[], month: string): number {
  return txs.filter((t) => active(t) && t.used_at.slice(0, 7) === month).reduce((s, t) => s + t.amount, 0);
}

export type StatementLike = { paid: number | boolean; debit_date: string | null; billing_month: string };
/**
 * Lower bound of notified-but-unpaid card usage: usage notifications dated after the latest paid
 * statement's debit date (or, without a debit date, after the end of its billing month). Usage before
 * that may already be settled, so it is not counted; nothing is ever assumed paid without a paid statement.
 */
export function notifiedUnpaidTotal(txs: TxLike[], statements: StatementLike[]): number {
  let cutoff = "";
  for (const s of statements) {
    if (!s.paid) continue;
    const edge = s.debit_date ?? `${lastDayOf(s.billing_month)}T23:59:59+09:00`;
    if (edge > cutoff) cutoff = edge;
  }
  return txs.filter((t) => active(t) && (!cutoff || t.used_at.slice(0, 10) > cutoff.slice(0, 10))).reduce((s, t) => s + t.amount, 0);
}
export function budgetLeft(budget: number | null, total: number): number | null {
  return budget == null ? null : budget - total;
}
/**
 * Cumulative series by day for the usage period only: from the 1st of the month to `today`
 * (never extended to the debit date). Days without usage carry the running total.
 */
export function cumulativeSeries(txs: TxLike[], month: string, today: string): { date: string; cumulative: number }[] {
  const byDay = new Map<string, number>();
  for (const t of txs) if (active(t) && t.used_at.slice(0, 7) === month) byDay.set(t.used_at.slice(0, 10), (byDay.get(t.used_at.slice(0, 10)) ?? 0) + t.amount);
  const end = today.slice(0, 7) === month ? today : lastDayOf(month);
  const out: { date: string; cumulative: number }[] = [];
  let run = 0;
  for (let d = new Date(`${month}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10); run += byDay.get(k) ?? 0; out.push({ date: k, cumulative: run });
  }
  return out;
}
export function lastDayOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export type GuideInput = {
  cash: number | null; cashFresh: boolean; reserve: number | null;
  unpaidConfirmed: number | null; notifiedTotal: number; budgetLeft: number | null;
  nextBonusDate: string | null; today: string;
};
/**
 * 追加利用の目安 (3-step rule):
 * 1. cash − reserve − confirmed unpaid card amount
 * 2. prorate to the months until the next bonus
 * 3. min(budget left, cash cap)
 * Undetermined when unpaid is unconfirmed, unpaid < notified total, or cash is stale/missing.
 */
export function extraSpendGuide(i: GuideInput): SpendGuide {
  if (i.cash == null) return { undetermined: true, reason: "信頼できる個人の円預金残高がありません" };
  if (!i.cashFresh) return { undetermined: true, reason: "預金残高が古いため判断を保留しています" };
  if (i.unpaidConfirmed == null) return { undetermined: true, reason: "未払いのカード額が未確認です" };
  if (i.unpaidConfirmed < i.notifiedTotal) return { undetermined: true, reason: `入力した未払い額（${Math.round(i.unpaidConfirmed).toLocaleString()}円）が取得済みの通知額（${Math.round(i.notifiedTotal).toLocaleString()}円）より小さいです` };
  if (i.budgetLeft == null) return { undetermined: true, reason: "月予算が未設定です" };
  const available = i.cash - (i.reserve ?? 0) - i.unpaidConfirmed;
  let months = 1;
  if (i.nextBonusDate) {
    const days = Math.round((Date.parse(i.nextBonusDate) - Date.parse(i.today)) / 86400e3);
    if (days > 0) months = Math.max(1, Math.ceil(days / 30));
  }
  const cashCap = Math.max(0, Math.floor(available / months));
  const amount = Math.max(0, Math.min(i.budgetLeft, cashCap));
  return { undetermined: false, amount, cash_cap: cashCap, budget_left: i.budgetLeft, months_to_bonus: months };
}

/* ---------- SMBC usage-notification mail ---------- */
export type ParsedMail = { used_at: string; merchant: string | null; amount: number } | null;
const Z = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[：]/g, ":").replace(/[，]/g, ",");
/**
 * Extracts used_at (ISO, JST), merchant and amount from 三井住友カード「ご利用のお知らせ」mail.
 * Patterns: ◇ご利用日時：2026/10/20 12:34 / ◇ご利用先：AMAZON.CO.JP / ◇ご利用金額：1,234円
 */
export function parseSmbcMail(subject: string, body: string): ParsedMail {
  const text = Z(body);
  if (!/ご利用/.test(subject) && !/ご利用/.test(text)) return null;
  const dt = text.match(/ご利用日時?\s*[:：]?\s*(\d{4})[\/年\-.](\d{1,2})[\/月\-.](\d{1,2})日?(?:\s*(?:\(.\))?\s*(\d{1,2})[:時](\d{2}))?/);
  const amt = text.match(/ご利用金額\s*[:：]?\s*([\d,]+)\s*円/);
  if (!dt || !amt) return null;
  const mer = text.match(/ご利用先\s*[:：]?\s*([^\r\n]+)/);
  const [, y, mo, d, hh, mm] = dt;
  const used_at = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${(hh ?? "0").padStart(2, "0")}:${(mm ?? "00")}:00+09:00`;
  const amount = Number(amt[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  return { used_at, merchant: mer ? mer[1].trim() || null : null, amount };
}

/* ---------- statement CSV ---------- */
export type StatementLine = { used_at: string; merchant: string | null; amount: number };
export type ParsedStatement = { lines: StatementLine[]; total: number | null; lines_total: number; valid: boolean; errors: string[] };
const yen = (s: string | undefined) => { if (s == null) return null; const n = Number(s.replace(/[",円¥\s]/g, "").replace(/^\((.*)\)$/, "-$1")); return Number.isFinite(n) && s.trim() !== "" ? n : null; };
function split(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out.map((s) => s.trim());
}
/**
 * Parses a card statement CSV: rows `date,merchant,amount[,...]`; the total row is one whose first
 * cell contains 合計 (or an empty date with 合計 in any cell). Validates sum(lines) == total.
 */
export function parseStatementCsv(text: string): ParsedStatement {
  const errors: string[] = []; const lines: StatementLine[] = []; let total: number | null = null;
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  for (const [i, raw] of rows.entries()) {
    const c = split(raw);
    if (c.some((x) => /合計|ご請求額|お支払い?金額/.test(x))) {
      const n = c.map(yen).filter((v): v is number => v != null && v !== 0);
      if (n.length) total = n[n.length - 1]; else errors.push(`${i + 1}行目: 合計行の金額が読めません`);
      continue;
    }
    const d = Z(c[0] ?? "").replace(/\//g, "-");
    const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) { if (i === 0) continue; errors.push(`${i + 1}行目: 日付が不正 (${c[0]})`); continue; }
    const amtIdx = c.length >= 3 ? 2 : 1;
    const amount = yen(c[amtIdx]);
    if (amount == null) { errors.push(`${i + 1}行目: 金額が不正`); continue; }
    lines.push({ used_at: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, merchant: c.length >= 3 ? c[1] || null : null, amount });
  }
  const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
  if (!lines.length) errors.push("明細行がありません");
  if (total == null) errors.push("合計行が見つかりません");
  else if (Math.round(total) !== Math.round(linesTotal)) errors.push(`合計（${total.toLocaleString()}円）と明細の和（${linesTotal.toLocaleString()}円）が一致しません`);
  return { lines, total, lines_total: linesTotal, valid: errors.length === 0, errors };
}

/* ---------- insights ---------- */
export function aggregateByMerchant(txs: (TxLike & { merchant?: string | null; category?: string | null })[]) {
  const m = new Map<string, { merchant: string; total: number; count: number }>();
  for (const t of txs) { if (!active(t)) continue; const k = t.merchant || "不明"; const v = m.get(k) ?? { merchant: k, total: 0, count: 0 }; v.total += t.amount; v.count++; m.set(k, v); }
  return [...m.values()].sort((a, b) => b.total - a.total);
}
