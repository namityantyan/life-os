-- Meals become a daily log: what was actually eaten, added with one tap from saved foods or sets.
-- meal_routines keeps its rows and becomes the "いつもの食事" set members (set_id groups them).

-- Saved single foods ("よく食べるもの"). Seeded from the existing routine items by the app.
CREATE TABLE IF NOT EXISTS meal_foods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL,
  unit TEXT,
  nutrition_json TEXT,
  nutrition_source TEXT,            -- recorded | estimated
  cost_per_serving REAL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meal_foods_user ON meal_foods(user_id, archived_at, use_count DESC);

-- Named sets ("いつもの朝食" etc). Members live in meal_routines.set_id.
CREATE TABLE IF NOT EXISTS meal_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What was actually eaten on a given JST day. Nutrition is copied in, so later edits to a
-- saved food never rewrite past days.
CREATE TABLE IF NOT EXISTS meal_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD (JST)
  food_name TEXT NOT NULL,
  amount REAL,
  unit TEXT,
  nutrition_json TEXT,
  nutrition_source TEXT,            -- recorded | estimated
  cost REAL,
  servings REAL NOT NULL DEFAULT 1,
  food_id TEXT,                     -- source food, if any (kept for "x回食べた" counts)
  set_id TEXT,                      -- set this entry came from, if any
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meal_entries_day ON meal_entries(user_id, day, sort_order);

ALTER TABLE meal_routines ADD COLUMN set_id TEXT;
