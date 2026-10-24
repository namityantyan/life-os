-- Oura daily_activity details (API v2), so activity advice can use Oura's own readiness-adjusted
-- daily target and the intensity split instead of steps alone. All values as returned by Oura:
-- times in seconds, distances in meters, calories in kcal. temperature_deviation comes from daily_readiness.
ALTER TABLE oura_daily ADD COLUMN activity_score INTEGER;
ALTER TABLE oura_daily ADD COLUMN active_calories INTEGER;
ALTER TABLE oura_daily ADD COLUMN target_calories INTEGER;
ALTER TABLE oura_daily ADD COLUMN target_meters INTEGER;
ALTER TABLE oura_daily ADD COLUMN meters_to_target INTEGER;
ALTER TABLE oura_daily ADD COLUMN equivalent_walking_distance INTEGER;
ALTER TABLE oura_daily ADD COLUMN high_activity_time INTEGER;
ALTER TABLE oura_daily ADD COLUMN medium_activity_time INTEGER;
ALTER TABLE oura_daily ADD COLUMN low_activity_time INTEGER;
ALTER TABLE oura_daily ADD COLUMN sedentary_time INTEGER;
ALTER TABLE oura_daily ADD COLUMN high_activity_met_minutes INTEGER;
ALTER TABLE oura_daily ADD COLUMN medium_activity_met_minutes INTEGER;
ALTER TABLE oura_daily ADD COLUMN inactivity_alerts INTEGER;
ALTER TABLE oura_daily ADD COLUMN activity_contributors_json TEXT;
ALTER TABLE oura_daily ADD COLUMN temperature_deviation REAL;
