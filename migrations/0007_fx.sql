-- FX: trade event idempotency ledger + helpful indexes.
CREATE TABLE IF NOT EXISTS fx_trade_events (
  user_id TEXT NOT NULL,
  event_key TEXT NOT NULL,       -- "<ticket>:<event>" (modify: "<ticket>:modify:<at>")
  ticket TEXT NOT NULL,
  event TEXT NOT NULL,           -- open | add | close | modify
  rule TEXT NOT NULL,
  pair TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_fx_trades_ticket ON fx_trades(user_id, ticket);
CREATE INDEX IF NOT EXISTS idx_fx_trades_status ON fx_trades(user_id, status, close_at);
CREATE INDEX IF NOT EXISTS idx_fx_signals_rule ON fx_signals(user_id, pair, rule, received_at);
