-- ============================================================================
-- Migration 003: Security & authentication tables
-- Login attempt tracking, refresh tokens, email verification, device sessions
-- ============================================================================

-- Login attempt tracking for brute-force protection
CREATE TABLE IF NOT EXISTS login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  ip_address  VARCHAR(45) NOT NULL,
  user_agent  TEXT DEFAULT NULL,
  success     BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_address, attempted_at DESC);

-- Refresh token rotation store
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL UNIQUE,
  device_info   VARCHAR(255) DEFAULT NULL,
  ip_address    VARCHAR(45) DEFAULT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  last_used_at  TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked = false;

-- Email verification tokens
CREATE TABLE IF NOT EXISTS verification_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL UNIQUE,
  type          VARCHAR(30) NOT NULL DEFAULT 'email_verification',
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_tokens_user ON verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_hash ON verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires ON verification_tokens(expires_at);

-- Device sessions (for "logout from all devices")
CREATE TABLE IF NOT EXISTS user_sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_info   VARCHAR(255) DEFAULT NULL,
  ip_address    VARCHAR(45) DEFAULT NULL,
  user_agent    TEXT DEFAULT NULL,
  is_current    BOOLEAN NOT NULL DEFAULT false,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- Admin security session table
CREATE TABLE IF NOT EXISTS admin_sessions (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  device_info   VARCHAR(255) DEFAULT NULL,
  ip_address    VARCHAR(45) DEFAULT NULL,
  user_agent    TEXT DEFAULT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
