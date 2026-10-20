-- Training: fast lookup of a session's sets and of open sessions.
CREATE INDEX IF NOT EXISTS idx_training_sets_session ON training_sets(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_training_sessions_user ON training_sessions(user_id, started_at);
