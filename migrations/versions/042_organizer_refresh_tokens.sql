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

-- ── Organizer Refresh Tokens ────────────────────────────────────────────────

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

-- ── Organizer Sessions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizer_sessions (
    id              SERIAL PRIMARY KEY,
    organizer_user_id INTEGER NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,
    device_info     TEXT,
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    is_current      BOOLEAN DEFAULT FALSE NOT NULL,
    revoked         BOOLEAN DEFAULT FALSE NOT NULL,
    last_active_at  TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Session listing per organizer
CREATE INDEX IF NOT EXISTS idx_organizer_sessions_user
    ON organizer_sessions(organizer_user_id, revoked, created_at);

COMMENT ON TABLE organizer_refresh_tokens IS 'SHA-256 hashed refresh tokens for organizer authentication — mirrors user refresh_tokens';
COMMENT ON TABLE organizer_sessions IS 'Device sessions for organizer accounts — mirrors user_sessions';
