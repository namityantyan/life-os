// FXシグナル — types shared between the Worker API, the React page and (by contract) the Windows connector.
// The server never places orders. The Windows connector (MT5) does, within the permissions served here.

export const PAIRS = ["USD/JPY", "EUR/JPY", "GBP/JPY", "AUD/JPY", "EUR/USD", "GBP/USD", "AUD/USD"] as const;
export type Pair = (typeof PAIRS)[number];

export const RULES = { rule_a: "ルールA改良版", donchian4: "ドンチャン改良4", donchian6: "ドンチャン改良6" } as const;
export type Rule = keyof typeof RULES;
export const RULE_KEYS = Object.keys(RULES) as Rule[];

export type Side = "BUY" | "SELL";
export type Timeframe = "M5" | "H1" | "H4" | "D1";
export const TIMEFRAMES: Timeframe[] = ["M5", "H1", "H4", "D1"];
export const TF_SECONDS: Record<Timeframe, number> = { M5: 300, H1: 3600, H4: 14400, D1: 86400 };

/** Pip size per pair (JPY crosses 0.01, others 0.0001). */
export const pipSize = (pair: string): number => (pair.endsWith("/JPY") ? 0.01 : 0.0001);

/** Fixed year configuration for ドンチャン改良4・6 (2026年度). New entries stop after this date. */
export const YEAR_CONFIG_VALID_UNTIL = "2027-10-01";
/** Connector is considered offline when no heartbeat arrived within this window. */
export const CONNECTOR_STALE_MS = 45_000;
/** Judgment-bar freshness per rule (rule A: 90 min on H1, donchian: 5 h on H4). */
export const SIGNAL_STALE_MS: Record<Rule, number> = { rule_a: 90 * 60_000, donchian4: 5 * 3600_000, donchian6: 5 * 3600_000 };
/** Single-terminal execution lease (seconds). */
export const LEASE_SECONDS = 30;

/* ---------- connector → server payloads ---------- */
export type ConnectorPosition = {
  ticket: string; rule: Rule; pair: string; side: Side; lots: number; open_price: number; sl: number | null; tp: number | null; open_at: string; pnl_usd?: number | null;
};
export type HeartbeatPayload = {
  terminal_id: string;           // stable id of the Windows terminal (lease holder)
  account: string;               // broker account id (masked is fine)
  equity: number | null;
  positions: ConnectorPosition[];
  lease_holder?: string;         // echo of the holder the connector believes it is
  version: string;               // connector version
  mt5_connected?: boolean;
  stop_reasons?: string[];       // reasons the connector stopped new entries (ledger mismatch etc.)
};

export type SignalStage = "none" | "setup" | "entry";
export type SignalPayload = {
  pair: string; rule: Rule; side: Side | null;
  /** none = evaluated, setup conditions not met (準備待ち); setup = 準備OK; entry = 条件成立 */
  stage: SignalStage;
  bar_time: string;              // ISO UTC of the *closed* judgment bar (H1 for rule_a, H4 for donchian)
  indicators?: Record<string, number | string | boolean | null>;
};

export type TradeEvent = "open" | "add" | "close" | "modify";
export type TradeEventPayload = {
  event: TradeEvent; ticket: string; rule: Rule; pair: string; side: Side;
  price: number; lots: number; sl: number | null; tp: number | null;
  pnl_usd?: number | null; r_multiple?: number | null; at: string; // ISO UTC
  group_ticket?: string | null;  // rule A: ticket of the first leg this add belongs to
  note?: string | null;
};

export type CandleBar = { t: number; o: number; h: number; l: number; c: number }; // t = unix seconds (bar open, UTC)
export type CandlesPayload = { pair: string; timeframe: Timeframe; bars: CandleBar[] };
export type QuotePayload = { pair: string; bid: number; ask: number; at: string };

/* ---------- server → connector permissions ---------- */
export type TradingHours = { start_utc: number; end_utc: number; weekdays_only: boolean };
export type RLimits = { day: number; week: number; month: number }; // negative R thresholds

export type FxSettings = {
  rules: Record<Rule, { enabled: boolean }>;
  common_lot: number;            // A・改良4 共通lot
  risk_usd_donchian6: number;    // 改良6の1回の想定損失 (USD)
  trading_hours: TradingHours;
  r_limits: RLimits;
  stop_reasons: string[];        // 自動停止理由 (manual notes; connector-reported reasons are kept in state)
};
export const DEFAULT_FX_SETTINGS: FxSettings = {
  rules: { rule_a: { enabled: false }, donchian4: { enabled: false }, donchian6: { enabled: false } },
  common_lot: 0.3,
  risk_usd_donchian6: 60,
  trading_hours: { start_utc: 6, end_utc: 20, weekdays_only: true },
  r_limits: { day: -2, week: -3, month: -2 },
  stop_reasons: [],
};

export type LeaseInfo = { holder: string | null; expires_at: string | null; held_by_you: boolean };
export type Permissions = {
  enabled_rules: Rule[];
  common_lot: number;
  risk_usd_donchian6: number;
  trading_hours: TradingHours;
  r_limits: RLimits;
  r_limit_block: { blocked: boolean; reason: string | null; day_r: number; week_r: number; month_r: number };
  year_config_valid_until: string;
  year_config_valid: boolean;
  lease: LeaseInfo;
  server_time: string;
};

/* ---------- UI models ---------- */
export type MarkKind = "ready_buy" | "ready_sell" | "entry_buy" | "entry_sell" | "waiting" | "stale";
export type SetupMark = { kind: MarkKind; label: string; side: Side | null; bar_time: string | null; reason: string | null };

export type PairRuleView = { rule: Rule; mark: SetupMark; enabled: boolean; received_at: string | null };
export type PairView = {
  pair: Pair; quote: { bid: number; ask: number; at: string } | null; quote_stale: boolean;
  rules: PairRuleView[];
};
export type PairsResponse = { connector_online: boolean; connector_last_seen: string | null; pairs: PairView[]; server_time: string };

export type TradeRow = {
  id: string; rule: Rule; pair: string; side: Side; ticket: string | null; open_at: string | null; close_at: string | null;
  open_price: number | null; close_price: number | null; lots: number | null; sl: number | null; tp: number | null;
  pnl_usd: number | null; r_multiple: number | null; status: "open" | "closed";
};

export type ChartLevel = { key: string; label: string; price: number; group: string; color?: string; dashed?: boolean };
export type ChartLine = { key: string; label: string; timeframe: Timeframe; points: { time: number; value: number }[]; color?: string };
export type ChartMarker = { time: number; kind: "entry" | "exit" | "signal"; side: Side; label: string; price?: number };
export type ChartResponse = {
  pair: string; timeframe: Timeframe; rule: Rule; from: number; to: number;
  candles: CandleBar[];
  stored_range: { from: number | null; to: number | null };
  missing_ranges: { from: number; to: number }[];
  lines: ChartLine[]; levels: ChartLevel[]; markers: ChartMarker[];
  insufficient: string[];        // indicators that could not be computed from stored history (never guessed)
  stats: { atr14_h1: number | null; adx14_h1: number | null; adx_required: number | null };
};

export type StatusResponse = {
  connector_online: boolean; last_seen: string | null; version: string | null; account: string | null; equity: number | null;
  mt5_connected: boolean | null; lease: LeaseInfo; terminal_id: string | null;
  r_limit_block: Permissions["r_limit_block"]; year_config_valid_until: string; year_config_valid: boolean;
  connector_stop_reasons: string[]; open_positions: number; token_configured: boolean;
};

export type PerformanceResponse = {
  note: string;
  by_rule: { rule: Rule; trades: number; wins: number; r_total: number; pnl_usd: number }[];
  by_pair: { pair: string; trades: number; wins: number; r_total: number; pnl_usd: number }[];
  by_month: { month: string; rule: Rule; trades: number; r_total: number; pnl_usd: number }[];
};
