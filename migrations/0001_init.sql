-- Life OS initial schema. All user data keyed by user_id.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Generic per-user settings (notification prefs, weather location, ui scale, budgets, fx settings...)
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS integration_tokens (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  token_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

-- Notifications ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS notification_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id TEXT,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL, -- push | discord
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | expired
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON notification_queue(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Planner ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- task | reminder | event
  title TEXT NOT NULL,
  notes TEXT,
  date TEXT,          -- YYYY-MM-DD for tasks (all-day placement)
  start_at TEXT,      -- ISO for events
  end_at TEXT,
  remind_at TEXT,     -- ISO for reminders
  reminded_at TEXT,
  done_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planner_user ON planner_items(user_id, archived_at, type);

-- Ideas & Notes ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  title TEXT,
  markdown TEXT,
  status TEXT NOT NULL DEFAULT 'inbox', -- inbox | someday | next | done
  organized_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other', -- policy | decision | promise | preference | other
  content TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Health -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oura_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sleep_duration_sec INTEGER,
  sleep_score INTEGER,
  readiness_score INTEGER,
  steps INTEGER,
  hrv REAL,
  resting_hr REAL,
  sleep_balance INTEGER,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS meal_routines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  slot TEXT NOT NULL, -- breakfast | lunch | dinner | snack
  food_name TEXT NOT NULL,
  amount REAL,
  unit TEXT,
  nutrition_json TEXT,         -- {energy_kcal, protein_g, fat_g, carbs_g, fiber_g, salt_g, ...}
  nutrition_source TEXT,       -- recorded | estimated
  cost_per_serving REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS beauty_routines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  product TEXT,
  timing TEXT,
  purpose TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS checkups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  checkup_date TEXT NOT NULL,
  ldl REAL, hdl REAL, tg REAL, total_chol REAL, hba1c REAL, fasting_glucose REAL,
  bp_sys REAL, bp_dia REAL, ggtp REAL, ast REAL, alt REAL, uric_acid REAL, creatinine REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pressure_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  logged_at TEXT NOT NULL,
  symptom TEXT,
  severity INTEGER,
  pressure_hpa REAL,
  delta3h REAL,
  delta6h REAL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL, -- health | meal | beauty | fp | discord | general
  role TEXT NOT NULL,    -- user | assistant
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, channel, created_at);

-- Training ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  part TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS training_sets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  exercise_key TEXT NOT NULL,
  weight REAL,
  reps INTEGER,
  duration_sec INTEGER,
  unit TEXT,        -- total | per_hand | plate | bodyweight | time
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sets_user ON training_sets(user_id, exercise_key, created_at);

-- Assets -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT 'personal', -- personal | <corporation name>
  owner_type TEXT NOT NULL DEFAULT 'personal', -- personal | corporate
  category TEXT NOT NULL, -- bank | securities | fx | crypto | insurance | cash | other | liability
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  unit TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | freee
  freee_company_id TEXT,
  freee_walletable_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS asset_balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  recorded_on TEXT NOT NULL,
  quantity REAL,          -- NULL = unknown; 0 = zero balance
  rate REAL,
  rate_date TEXT,
  rate_source TEXT,
  jpy_value REAL,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | freee | csv
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_balances_acc ON asset_balances(account_id, recorded_on);

-- Cards ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  used_at TEXT NOT NULL,
  merchant TEXT,
  amount REAL NOT NULL,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- gmail | csv | manual
  external_id TEXT,
  status TEXT NOT NULL DEFAULT 'approved', -- approved | cancelled | confirmed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_card_tx_user ON card_transactions(user_id, used_at);
CREATE TABLE IF NOT EXISTS card_statements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  billing_month TEXT NOT NULL, -- YYYY-MM
  amount REAL NOT NULL,
  debit_date TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  line_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FX ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fx_connector_state (
  user_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fx_signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  rule TEXT NOT NULL,   -- rule_a | donchian4 | donchian6
  side TEXT NOT NULL,   -- BUY | SELL
  stage TEXT NOT NULL,  -- setup | entry
  bar_time TEXT NOT NULL,
  payload_json TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fx_signals ON fx_signals(user_id, pair, received_at);
CREATE TABLE IF NOT EXISTS fx_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,
  ticket TEXT,
  open_at TEXT,
  close_at TEXT,
  open_price REAL,
  close_price REAL,
  lots REAL,
  sl REAL,
  tp REAL,
  pnl_usd REAL,
  r_multiple REAL,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  payload_json TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fx_candles (
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL, -- M5 | H1 | H4 | D1
  time INTEGER NOT NULL,   -- unix seconds (bar open)
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  PRIMARY KEY (pair, timeframe, time)
);
CREATE TABLE IF NOT EXISTS fx_quotes (
  pair TEXT PRIMARY KEY,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  quoted_at TEXT NOT NULL
);

-- Finance / Royalty --------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  amount REAL NOT NULL,
  tax REAL NOT NULL DEFAULT 0,
  withholding REAL NOT NULL DEFAULT 0,
  pdf_total REAL,
  status TEXT NOT NULL DEFAULT 'issued', -- issued | paid
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS royalty_mails (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- nextone | dcoret | mcjp | rights_services | ponycanyon | basemint | unknown
  subject TEXT NOT NULL,
  sender TEXT,
  received_at TEXT NOT NULL,
  target_month TEXT,
  status TEXT NOT NULL DEFAULT 'review', -- target | review | excluded
  processed INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Backups ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_sec REAL,
  personal_count INTEGER,
  team_count INTEGER,
  personal_bytes INTEGER,
  team_bytes INTEGER,
  errors INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  content_json TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, run_id)
);

-- Requests -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  example TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | done
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Discord ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discord_links (
  discord_user_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_channels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cron bookkeeping ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_runs (
  job TEXT NOT NULL,
  key TEXT NOT NULL,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job, key)
);
