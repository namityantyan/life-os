-- Which 日本食品標準成分表 food (and how many grams) a nutrition value was computed from.
-- nutrition_source gains the value 'table' (computed from the table) next to recorded / estimated.
ALTER TABLE meal_entries ADD COLUMN nutrition_ref TEXT;
ALTER TABLE meal_foods ADD COLUMN nutrition_ref TEXT;
ALTER TABLE meal_routines ADD COLUMN nutrition_ref TEXT;
