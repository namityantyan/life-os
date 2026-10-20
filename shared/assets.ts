// Shared types for the 資産 (assets) module.
export const ASSET_CATEGORIES = ["bank", "securities", "fx", "crypto", "insurance", "cash", "other", "liability"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  bank: "銀行預金", securities: "証券", fx: "FX", crypto: "暗号資産", insurance: "保険・共済", cash: "現金", other: "その他", liability: "負債",
};
/** Categories whose value moves with market prices; never mixed into "usable cash". */
export const VOLATILE_CATEGORIES: AssetCategory[] = ["securities", "fx", "crypto"];
export type OwnerType = "personal" | "corporate";

export type AssetAccount = {
  id: string; owner: string; owner_type: OwnerType; category: AssetCategory; name: string;
  currency: string; unit: string | null; source: "manual" | "freee";
  freee_company_id: string | null; freee_walletable_id: string | null;
  sort_order: number; archived_at: string | null; created_at: string;
};
export type AssetBalance = {
  id: string; account_id: string; recorded_on: string; quantity: number | null; rate: number | null;
  rate_date: string | null; rate_source: string | null; jpy_value: number | null;
  source: "manual" | "freee" | "csv"; synced_at: string | null; created_at: string;
};
export type LatestBalance = AssetBalance & { stale: boolean; age_days: number | null };

export type BalancesResponse = {
  from: string; to: string;
  /** Actual range of stored records within the filter (null when nothing recorded). */
  recorded_range: { from: string; to: string } | null;
  accounts: AssetAccount[];
  series: { date: string; total: number; carried: boolean }[];
  latest: Record<string, LatestBalance>;
  /** Per-date, per-account rows in [from,to] (for the entry grid / export). */
  rows: AssetBalance[];
};

export type AssetPlan = {
  living_cost_monthly: number | null;
  planned_expenses: { label: string; amount: number; due?: string | null }[];
  debts: { label: string; amount: number }[];
  reserve_amount: number | null;
  income_next: { date: string | null; amount: number | null } | null;
};

export type Allocation =
  | { undetermined: true; reason: string; as_of: string | null }
  | {
      undetermined: false; as_of: string; cash: number;
      protect: number; spend: number; invest: number;
      breakdown: { living_months: number; living: number; planned: number; debts: number; reserve: number };
    };

export type AssetOverview = {
  as_of: string | null;
  total: number | null; // sum of non-liability latest values (NOT net worth)
  liabilities: number | null;
  by_owner_type: { owner_type: OwnerType; total: number; stale: boolean }[];
  by_category: { category: AssetCategory; total: number; stale: boolean }[];
  accounts: (AssetAccount & { latest: LatestBalance | null })[];
  stale_count: number; unknown_count: number;
};
