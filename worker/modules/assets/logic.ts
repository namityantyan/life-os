// Pure logic for the 資産 module (no D1): staleness, allocation, copy-previous, CSV.
import type { AssetAccount, AssetBalance, AssetPlan, Allocation } from "@shared/assets";
import { VOLATILE_CATEGORIES } from "@shared/assets";

export const STALE_DAYS = 2;

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3);
}

/** A balance is stale when its recorded_on is more than STALE_DAYS before `today`. */
export function isStale(recordedOn: string | null | undefined, today: string): boolean {
  if (!recordedOn) return true;
  return daysBetween(recordedOn.slice(0, 10), today) > STALE_DAYS;
}

/** jpy_value for a balance row: JPY uses quantity; other currencies need quantity×rate. */
export function computeJpy(currency: string, quantity: number | null, rate: number | null, explicit?: number | null): number | null {
  if (explicit != null && Number.isFinite(explicit)) return explicit;
  if (quantity == null) return null;
  if (currency === "JPY") return quantity;
  if (rate == null) return null;
  return quantity * rate;
}

export type EntryField = { account_id: string; quantity: number | null; rate?: number | null; jpy_value?: number | null };
/**
 * "前回値をコピー" fills ONLY empty (null quantity) fields from the previous known balance.
 * Explicit 0 is kept (0 = zero balance, never "unknown").
 */
export function fillFromPrevious(entries: EntryField[], previous: Record<string, Pick<AssetBalance, "quantity" | "rate" | "jpy_value"> | undefined>): EntryField[] {
  return entries.map((e) => {
    if (e.quantity != null) return e;
    const p = previous[e.account_id];
    if (!p || p.quantity == null) return e;
    return { ...e, quantity: p.quantity, rate: e.rate ?? p.rate ?? null, jpy_value: e.jpy_value ?? p.jpy_value ?? null };
  });
}

export type CashInput = { account: Pick<AssetAccount, "owner_type" | "category" | "currency" | "archived_at">; recorded_on: string; jpy_value: number | null };
/**
 * Fresh personal JPY bank cash: sums latest balances of personal, JPY, bank accounts that are
 * fresh (≤ STALE_DAYS). Returns null when no qualifying fresh balance exists or any is unknown.
 */
export function freshPersonalCash(latest: CashInput[], today: string): { amount: number | null; as_of: string | null; reason?: string } {
  const bank = latest.filter((l) => l.account.owner_type === "personal" && l.account.category === "bank" && l.account.currency === "JPY" && !l.account.archived_at && !VOLATILE_CATEGORIES.includes(l.account.category));
  if (!bank.length) return { amount: null, as_of: null, reason: "個人の円建て銀行口座の残高が未登録です" };
  const stale = bank.filter((b) => isStale(b.recorded_on, today));
  if (stale.length) return { amount: null, as_of: bank.map((b) => b.recorded_on).sort().at(-1) ?? null, reason: `残高が${STALE_DAYS}日より古い口座があります（${stale.length}件）` };
  if (bank.some((b) => b.jpy_value == null)) return { amount: null, as_of: null, reason: "残高が不明（空欄）の口座があります" };
  return { amount: bank.reduce((s, b) => s + (b.jpy_value ?? 0), 0), as_of: bank.map((b) => b.recorded_on).sort()[0] };
}

/**
 * 守る額 / 使う額 / 運用に回す額.
 * protect = living cost until next income (min 1 month) + planned expenses + debts + reserve.
 * spend   = min(living cost for one month, cash − protect) when positive.
 * invest  = max(0, cash − protect − spend).
 */
export function computeAllocation(cash: { amount: number | null; as_of: string | null; reason?: string }, plan: AssetPlan, today: string): Allocation {
  if (cash.amount == null) return { undetermined: true, reason: cash.reason ?? "信頼できる残高がありません", as_of: cash.as_of };
  if (plan.living_cost_monthly == null) return { undetermined: true, reason: "毎月の生活費が未設定です", as_of: cash.as_of };
  let months = 1;
  if (plan.income_next?.date) {
    const d = daysBetween(today, plan.income_next.date);
    if (d > 0) months = Math.max(1, Math.ceil(d / 30));
  }
  const living = plan.living_cost_monthly * months;
  const planned = (plan.planned_expenses ?? []).reduce((s, p) => s + (p.amount || 0), 0);
  const debts = (plan.debts ?? []).reduce((s, d) => s + (d.amount || 0), 0);
  const reserve = plan.reserve_amount ?? 0;
  const protect = living + planned + debts + reserve;
  const free = cash.amount - protect;
  const spend = free > 0 ? Math.min(plan.living_cost_monthly, free) : 0;
  const invest = Math.max(0, free - spend);
  return { undetermined: false, as_of: cash.as_of!, cash: cash.amount, protect, spend, invest, breakdown: { living_months: months, living, planned, debts, reserve } };
}

/* ---------- CSV ---------- */
export type CsvRow = { date: string; account: string; quantity: number | null; rate: number | null; jpy_value: number | null };
const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(rows: CsvRow[]): string {
  return ["date,account,quantity,rate,jpy_value", ...rows.map((r) => [r.date, r.account, r.quantity, r.rate, r.jpy_value].map(esc).join(","))].join("\n") + "\n";
}
export function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out.map((s) => s.trim());
}
const num = (s: string | undefined): number | null => { if (s == null || s === "") return null; const n = Number(s.replace(/[,円¥\s]/g, "")); return Number.isFinite(n) ? n : null; };
/** Parses `date,account,quantity,rate,jpy_value` rows (header optional). Invalid rows are reported, not silently dropped. */
export function parseBalanceCsv(text: string): { rows: CsvRow[]; errors: string[] } {
  const rows: CsvRow[] = []; const errors: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  lines.forEach((line, i) => {
    const c = splitCsvLine(line);
    if (i === 0 && /^date$/i.test(c[0] ?? "")) return;
    const date = (c[0] ?? "").replace(/\//g, "-");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(`${i + 1}行目: 日付が不正 (${c[0]})`); return; }
    if (!c[1]) { errors.push(`${i + 1}行目: 口座名が空`); return; }
    rows.push({ date, account: c[1], quantity: num(c[2]), rate: num(c[3]), jpy_value: num(c[4]) });
  });
  return { rows, errors };
}
