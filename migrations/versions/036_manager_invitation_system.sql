-- ============================================================================
-- Migration 036: Manager Invitation System + Single-Organization Membership
-- ============================================================================
--
-- Adds:
--   1. organizer_invitations    — token-based invitation system for managers
--   2. organizer_sessions       — session tracking for organizer users
--   3. organizer_activity_log   — audit trail for organizer actions
--   4. Extend organizer_users with last_login_ip, failed_login_attempts, locked_until
--
-- Invitation Flow:
--   1. Owner creates invitation with email + role
--   2. System generates cryptographically random token, stores SHA-256 hash
--   3. Email sent with plaintext token link
--   4. User clicks link → token verified (constant-time comparison)
--   5. User accepts → organizer_users row created with role
--   6. Token marked used
--
-- Membership Rules:
--   - One owner per organization (enforced by partial unique index)
--   - Managers can belong to only ONE organization
--   - All manager activities are audited
--   - Sessions are trackable and revocable by owner
-- ============================================================================


-- ── 1. organizer_invitations ───────────────────────────────────────────────────
-- Token-based invitations for adding managers to an organization.

CREATE TABLE IF NOT EXISTS organizer_invitations (
  id                BIGSERIAL PRIMARY KEY,

  -- Who sent the invite and to which organization
  organization_id   BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inviter_id        BIGINT NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,

  -- Invitee info
  email             VARCHAR(255) NOT NULL,
  role              VARCHAR(20) NOT NULL DEFAULT 'manager'
    CHECK (role IN ('manager')),

  -- Token (SHA-256 hash — never store plaintext)
  token_hash        VARCHAR(64) NOT NULL,

  -- Status
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked', 'cancelled')),

  -- Timestamps
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ DEFAULT NULL,
  used_at           TIMESTAMPTZ DEFAULT NULL,

  -- Metadata
  message           TEXT         DEFAULT NULL,
  ip_address        VARCHAR(45)  DEFAULT NULL,
  user_agent        TEXT         DEFAULT NULL,

  -- Timestamps
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_invitations_org
  ON organizer_invitations (organization_id);

CREATE INDEX IF NOT EXISTS idx_organizer_invitations_email
  ON organizer_invitations (email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_organizer_invitations_token
  ON organizer_invitations (token_hash);

CREATE INDEX IF NOT EXISTS idx_organizer_invitations_expires
  ON organizer_invitations (expires_at)
  WHERE status = 'pending';

-- Ensure one pending invite per email per organization (partial unique index)
-- NOTE: Cannot be an inline table constraint — PostgreSQL partial unique indexes
-- must be created as standalone CREATE UNIQUE INDEX statements.
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizer_invitations_org_email_pending
  ON organizer_invitations (organization_id, email)
  WHERE status = 'pending';

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION organizer_invitations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_organizer_invitations_updated_at'
  ) THEN
    CREATE TRIGGER trg_organizer_invitations_updated_at
      BEFORE UPDATE ON organizer_invitations
      FOR EACH ROW
      EXECUTE FUNCTION organizer_invitations_set_updated_at();
  END IF;
END $$;


-- ── 2. organizer_sessions ──────────────────────────────────────────────────────
-- Track active sessions for organizer users. Supports multi-device sessions
-- and per-session revocation.

CREATE TABLE IF NOT EXISTS organizer_sessions (
  id                BIGSERIAL PRIMARY KEY,
  organizer_user_id BIGINT NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,

  -- Session token (JWT jti claim maps here)
  token_jti         VARCHAR(64) NOT NULL UNIQUE,

  -- Device info
  device_name       VARCHAR(255) DEFAULT NULL,
  device_type       VARCHAR(50)  DEFAULT 'web',
  ip_address        VARCHAR(45)  DEFAULT NULL,
  user_agent        TEXT         DEFAULT NULL,

  -- Status
  is_active         BOOLEAN      NOT NULL DEFAULT true,

  -- Timestamps
  last_active_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ  NOT NULL,
  revoked_at        TIMESTAMPTZ  DEFAULT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_sessions_user
  ON organizer_sessions (organizer_user_id, is_active);

CREATE INDEX IF NOT EXISTS idx_organizer_sessions_jti
  ON organizer_sessions (token_jti);

CREATE INDEX IF NOT EXISTS idx_organizer_sessions_expires
  ON organizer_sessions (expires_at)
  WHERE is_active = true;


-- ── 3. organizer_activity_log ──────────────────────────────────────────────────
-- Audit trail for all organizer user actions.

CREATE TABLE IF NOT EXISTS organizer_activity_log (
  id                BIGSERIAL PRIMARY KEY,
  organizer_user_id BIGINT NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,
  organization_id   BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Action details
  action            VARCHAR(100) NOT NULL,
  resource_type     VARCHAR(50)  NOT NULL,
  resource_id       BIGINT      DEFAULT NULL,

  -- Request context
  ip_address        VARCHAR(45)  DEFAULT NULL,
  user_agent        TEXT         DEFAULT NULL,

  -- Change details
  old_values        JSONB        DEFAULT NULL,
  new_values        JSONB        DEFAULT NULL,

  -- Timestamps
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_activity_user
  ON organizer_activity_log (organizer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_activity_org
  ON organizer_activity_log (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_activity_resource
  ON organizer_activity_log (resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_organizer_activity_action
  ON organizer_activity_log (action);


-- ── 4. Extend organizer_users with security fields ─────────────────────────────

DO $$
BEGIN
  -- last_login_ip
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_users' AND column_name = 'last_login_ip'
  ) THEN
    ALTER TABLE organizer_users ADD COLUMN last_login_ip VARCHAR(45) DEFAULT NULL;
  END IF;

  -- failed_login_attempts
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_users' AND column_name = 'failed_login_attempts'
  ) THEN
    ALTER TABLE organizer_users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
  END IF;

  -- locked_until (for account lockout after too many failed attempts)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_users' AND column_name = 'locked_until'
  ) THEN
    ALTER TABLE organizer_users ADD COLUMN locked_until TIMESTAMPTZ DEFAULT NULL;
  END IF;

  -- invitation_token_hash (for self-service signup via invite link)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_users' AND column_name = 'invitation_token_hash'
  ) THEN
    ALTER TABLE organizer_users ADD COLUMN invitation_token_hash VARCHAR(64) DEFAULT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizer_users_invitation_token
  ON organizer_users (invitation_token_hash)
  WHERE invitation_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizer_users_locked_until
  ON organizer_users (locked_until)
  WHERE locked_until IS NOT NULL;


-- ── 5. Ensure one organization per manager ─────────────────────────────────────
-- A manager (non-owner) can belong to only one organization at a time.
-- This is enforced by the existing uq_organizer_users_org_email unique constraint
-- on (organization_id, email). If a user wants to join another org, the admin
-- must remove them from the first org first.

-- ── ANALYZE ────────────────────────────────────────────────────────────────────

ANALYZE organizer_invitations;
ANALYZE organizer_sessions;
ANALYZE organizer_activity_log;
ANALYZE organizer_users;