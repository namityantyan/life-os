-- Meals rebuild: indexes only (no schema or data change).
-- Set members are read per user and grouped by set; sets are listed per user in order;
-- per-day totals read a date range; saved foods are looked up by name (よく食べるものに登録).
CREATE INDEX IF NOT EXISTS idx_meal_routines_user_set ON meal_routines(user_id, set_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_meal_sets_user ON meal_sets(user_id, archived_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_meal_foods_user_name ON meal_foods(user_id, name);
CREATE INDEX IF NOT EXISTS idx_meal_entries_food ON meal_entries(user_id, food_id);
