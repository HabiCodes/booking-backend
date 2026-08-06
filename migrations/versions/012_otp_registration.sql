-- ============================================================================
-- Migration 012: OTP-based registration — pending_registrations table
-- ============================================================================
-- Design:
--  - A separate table holds registration details while the user completes
--    OTP verification.  The actual users row is NOT created until OTP
--    verification succeeds.
--  - Only the SHA-256 hash of the OTP is stored — never the plain code.
--  - Uniqueness is enforced on (email) among unconsumed rows so that a
--    second request invalidates the prior pending row.
--  - Indexes support the common lookups: find by email, find by otp_hash,
--    and cleanup of expired rows.
--  - Safe to re-run: IF NOT EXISTS everywhere.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pending_registrations (
  id               BIGSERIAL PRIMARY KEY,
  email            VARCHAR(255) NOT NULL,
  username         VARCHAR(255),
  password_hash    VARCHAR(255) NOT NULL,
  otp_hash         VARCHAR(64)  NOT NULL,
  otp_attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ  NOT NULL,
  consumed_at      TIMESTAMPTZ  DEFAULT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Uniqueness: one active pending registration per email ──────────────────────
-- (only rows that haven't been consumed count as active)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_email_unique
  ON pending_registrations (email)
  WHERE consumed_at IS NULL;

-- ── Lookup: find a pending registration by email ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pending_registrations_email
  ON pending_registrations (email);

-- ── Lookup: find by otp_hash for verification ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pending_registrations_otp_hash
  ON pending_registrations (otp_hash);

-- ── Cleanup: expire old pending registrations ─────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_pending_registrations_expires_at
  ON pending_registrations (expires_at)
  WHERE consumed_at IS NULL;
