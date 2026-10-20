// Shared types for the カード利用 (cards) module.
export type CardTransaction = {
  id: string; used_at: string; merchant: string | null; amount: number; category: string | null;
  source: "gmail" | "csv" | "manual"; external_id: string | null; status: "approved" | "cancelled" | "confirmed";
  statement_id: string | null; created_at: string;
};
export type CardStatement = {
  id: string; billing_month: string; amount: number; debit_date: string | null; confirmed: number; paid: number;
  line_count: number | null; csv_total: number | null; note: string | null; created_at: string;
};
export type CardSettings = {
  monthly_budget: number | null; reserve_cash: number | null; unpaid_confirmed: number | null; next_bonus_date: string | null;
};
export type SpendGuide =
  | { undetermined: true; reason: string }
  | { undetermined: false; amount: number; cash_cap: number; budget_left: number; months_to_bonus: number };
export type CardOverview = {
  month: string; today: string;
  month_total: number; count: number; budget: number | null; budget_left: number | null;
  series: { date: string; cumulative: number }[];
  timeline: (CardTransaction & { running: number })[];
  statement: CardStatement | null; // current (unpaid / nearest upcoming)
  notified_unpaid: number; // approved tx not yet in a paid statement
  cash: { amount: number | null; fresh: boolean; as_of: string | null };
  guide: SpendGuide; gmail_connected: boolean;
};
