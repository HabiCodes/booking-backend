-- Migration 042: Organizer refresh tokens and sessions
-- Date: 2026-08-26
--
-- Mirrors the user authentication architecture:
--   refresh_tokens + user_sessions
-- with organizer-specific tables:
--   organizer_refresh_tokens + organizer_sessions
--
-- Provides:
--   - Persistent refresh tokens (hashed, not plaintext)
--   - Token rotation via atomic find-and-consume
--   - Reuse detection (full revocation on double-use)
--   - Session tracking for "logout from specific device"
--   - Server-side revocation

-- Handle existing organizer_sessions table (from migration 036) that has
-- is_active/revoked_at columns instead of the newer revoked/is_current schema.
-- Upgrade the table in-place if needed, then continue with the rest.

-- ── Upgrade organizer_sessions schema if needed ───────────────────────────────

DO $$
BEGIN
  -- If the table exists but lacks the 'revoked' column, upgrade it
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organizer_sessions')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'organizer_sessions' AND column_name = 'revoked') THEN
    -- Migrate is_active → revoked: is_active=true means NOT revoked
    ALTER TABLE organizer_sessions ADD COLUMN revoked BOOLEAN DEFAULT TRUE NOT NULL;
    UPDATE organizer_sessions SET revoked = NOT is_active WHERE revoked = TRUE;
    ALTER TABLE organizer_sessions ALTER COLUMN revoked DROP DEFAULT;
    -- Migrate revoked_at → revoked
    ALTER TABLE organizer_sessions DROP COLUMN revoked_at;
    -- Rename is_active → is_current (same semantics)
    ALTER TABLE organizer_sessions RENAME COLUMN is_active TO is_current;
  END IF;
END $$;

-- Drop old indexes that reference the old column names
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_organizer_sessions_user') THEN
    DROP INDEX IF EXISTS idx_organizer_sessions_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_organizer_sessions_jti') THEN
    DROP INDEX IF EXISTS idx_organizer_sessions_jti;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_organizer_sessions_expires') THEN
    DROP INDEX IF EXISTS idx_organizer_sessions_expires;
  END IF;
END $$;

-- Create indexes on the current schema
CREATE INDEX IF NOT EXISTS idx_organizer_sessions_user
    ON organizer_sessions(organizer_user_id, revoked, created_at);

-- ── Organizer Refresh Tokens ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizer_refresh_tokens (
    id              SERIAL PRIMARY KEY,
    organizer_user_id INTEGER NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(64) NOT NULL,
    session_id      INTEGER REFERENCES organizer_sessions(id) ON DELETE CASCADE,
    device_info     TEXT,
    ip_address      VARCHAR(45),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN DEFAULT FALSE NOT NULL,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- SHA-256 hash lookups
CREATE INDEX IF NOT EXISTS idx_organizer_refresh_tokens_hash
    ON organizer_refresh_tokens(token_hash);

-- Cleanup expired/revoked tokens
CREATE INDEX IF NOT EXISTS idx_organizer_refresh_tokens_user
    ON organizer_refresh_tokens(organizer_user_id, revoked, expires_at);

-- Unique hash constraint (prevents duplicate inserts)
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizer_refresh_tokens_hash
    ON organizer_refresh_tokens(token_hash) WHERE revoked = false;

COMMENT ON TABLE organizer_refresh_tokens IS 'SHA-256 hashed refresh tokens for organizer authentication — mirrors user refresh_tokens';
COMMENT ON TABLE organizer_sessions IS 'Device sessions for organizer accounts — mirrors user_sessions';
