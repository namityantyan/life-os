-- Performance indexes (no schema change). Context/notes list: WHERE user_id AND archived_at IS NULL ORDER BY updated_at DESC;
-- FX status: latest signals per user ORDER BY received_at DESC.
CREATE INDEX IF NOT EXISTS idx_notes_user_active ON notes(user_id, archived_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_fx_signals_user_received ON fx_signals(user_id, received_at);
