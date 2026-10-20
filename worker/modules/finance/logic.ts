/** Pure finance logic: Japanese freelance withholding, PDF reconciliation, monthly aggregation, invoice-mail detection. */

export const WITHHOLDING_THRESHOLD = 1_000_000;
export const WITHHOLDING_RATE_LOW = 0.1021;
export const WITHHOLDING_RATE_HIGH = 0.2042;
export const TAX_RATE = 0.1;

/** 源泉徴収税額（報酬・料金）: 100万円以下 10.21%、超過分 20.42%。1円未満切り捨て。 */
export function computeWithholding(fee: number): number {
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const low = Math.min(fee, WITHHOLDING_THRESHOLD) * WITHHOLDING_RATE_LOW;
  const high = Math.max(fee - WITHHOLDING_THRESHOLD, 0) * WITHHOLDING_RATE_HIGH;
  return Math.floor(low + high + 1e-9);
}

/** 消費税（10%、1円未満切り捨て）。 */
export function computeTax(fee: number, rate = TAX_RATE): number {
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  return Math.floor(fee * rate + 1e-9);
}

export type InvoiceLike = { amount: number; tax: number; withholding: number; pdf_total: number | null };

/** 請求額（振込額）= 報酬 + 消費税 − 源泉徴収。 */
export function computeTotal(inv: Pick<InvoiceLike, "amount" | "tax" | "withholding">): number {
  return Math.round(inv.amount + inv.tax - inv.withholding);
}

export type Reconcile = { status: "match" | "mismatch" | "unverified"; computed: number; pdf_total: number | null; diff: number | null };

/** PDF記載額と計算値の照合。許容差 ±1円。pdf_total 未入力は unverified。 */
export function reconcilePdfTotal(inv: InvoiceLike, tolerance = 1): Reconcile {
  const computed = computeTotal(inv);
  if (inv.pdf_total == null || !Number.isFinite(inv.pdf_total)) return { status: "unverified", computed, pdf_total: null, diff: null };
  const diff = Math.round(inv.pdf_total - computed);
  return { status: Math.abs(diff) <= tolerance ? "match" : "mismatch", computed, pdf_total: inv.pdf_total, diff };
}

export type MonthlyRow = { month: string; count: number; amount: number; tax: number; withholding: number; total: number; mismatches: number };

/** 月別集計（issued_on の YYYY-MM）。該当月の無い月も 0 件で返す（year 指定時）。 */
export function aggregateMonthly(invoices: (InvoiceLike & { issued_on: string })[], year?: number): MonthlyRow[] {
  const map = new Map<string, MonthlyRow>();
  if (year) for (let m = 1; m <= 12; m++) { const k = `${year}-${String(m).padStart(2, "0")}`; map.set(k, { month: k, count: 0, amount: 0, tax: 0, withholding: 0, total: 0, mismatches: 0 }); }
  for (const inv of invoices) {
    const k = inv.issued_on.slice(0, 7);
    if (year && !k.startsWith(String(year))) continue;
    const row = map.get(k) ?? { month: k, count: 0, amount: 0, tax: 0, withholding: 0, total: 0, mismatches: 0 };
    row.count++; row.amount += inv.amount; row.tax += inv.tax; row.withholding += inv.withholding; row.total += computeTotal(inv);
    if (reconcilePdfTotal(inv).status === "mismatch") row.mismatches++;
    map.set(k, row);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export type MailRules = { include: string[]; exclude: string[]; senders: string[] };
export const DEFAULT_MAIL_RULES: MailRules = {
  include: ["請求書", "領収書", "receipt", "invoice", "ご請求", "御請求"],
  exclude: ["newsletter", "メルマガ", "キャンペーン", "unsubscribe", "noreply@google.com", "starbucks", "スターバックス", "google play", "apple.com"],
  senders: [],
};

export type MailDetection = { match: boolean; reason: string; kind: "invoice" | "receipt" | null };

/** 請求書・領収書メールの検知。除外語が先に勝つ。senders は送信元の部分一致（空なら送信元で絞らない）。 */
export function detectInvoiceMail(subject: string, from: string, rules: MailRules = DEFAULT_MAIL_RULES): MailDetection {
  const s = (subject ?? "").toLowerCase();
  const f = (from ?? "").toLowerCase();
  for (const x of rules.exclude) { const k = x.toLowerCase().trim(); if (k && (s.includes(k) || f.includes(k))) return { match: false, reason: `除外: ${x}`, kind: null }; }
  if (rules.senders.length && !rules.senders.some((x) => f.includes(x.toLowerCase().trim()))) return { match: false, reason: "送信元が条件外", kind: null };
  for (const x of rules.include) {
    const k = x.toLowerCase().trim();
    if (k && s.includes(k)) {
      const kind: MailDetection["kind"] = /領収|receipt/.test(k) ? "receipt" : "invoice";
      return { match: true, reason: `件名: ${x}`, kind };
    }
  }
  return { match: false, reason: "該当なし", kind: null };
}

/** 前月 (YYYY-MM) を JST 日付から求める。 */
export function previousMonth(jstDate: string): string {
  const [y, m] = jstDate.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
