-- Push devices: delivery status per device and the VAPID key each subscription was made with
-- (a key change makes old subscriptions unusable; the app re-subscribes when they differ).
ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_ok_at TEXT;
ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;
-- Discord delivery is off: drop queued Discord messages and subscriptions that were only switched off.
UPDATE notification_queue SET status='cancelled', last_error='discord disabled' WHERE channel='discord' AND status='pending';
DELETE FROM push_subscriptions WHERE enabled=0;
