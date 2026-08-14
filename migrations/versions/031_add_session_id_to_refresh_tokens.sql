-- 031_add_session_id_to_refresh_tokens.sql
-- Links refresh tokens to device sessions so rotation can propagate
-- session revocation and the "active sessions" list stays accurate.

-- 1. Add session_id column (nullable — existing rows stay valid)
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS session_id BIGINT
    REFERENCES user_sessions(id) ON DELETE CASCADE;

-- 2. Index for lookups by session
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_session
  ON refresh_tokens(session_id)
  WHERE session_id IS NOT NULL;

-- 3. Update last_used_at whenever a token is consumed (via trigger)
--    This helps detect stale tokens and provides audit data.
CREATE OR REPLACE FUNCTION update_refresh_token_last_used()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_used_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refresh_token_last_used ON refresh_tokens;
CREATE TRIGGER trg_refresh_token_last_used
  BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW
  WHEN (OLD.revoked IS DISTINCT FROM NEW.revoked OR OLD.last_used_at IS DISTINCT FROM NEW.last_used_at)
  EXECUTE FUNCTION update_refresh_token_last_used();
