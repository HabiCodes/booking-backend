-- ============================================================================
-- Migration 021: Manager Invitation Tokens + Event Revenue Helpers
-- ============================================================================

-- ── 1. manager_invitations ─────────────────────────────────────────────────────
-- Time-limited, single-use invitations for managers/staff. Created by an
-- organizer owner; accepted by the invitee via a signup flow.

CREATE TABLE IF NOT EXISTS manager_invitations (
  id                BIGSERIAL PRIMARY KEY,

  -- Tenant scope
  organization_id   BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Inviter
  invited_by_user_id BIGINT NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,

  -- Invitee
  email             VARCHAR(255) NOT NULL,
  name              VARCHAR(255) DEFAULT NULL,

  -- One-time token (SHA-256 hash stored)
  token_hash        VARCHAR(64)  NOT NULL,

  -- Scoped permissions (JSONB). If empty, inherits default manager permissions.
  permissions       JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Expiry
  expires_at        TIMESTAMPTZ  NOT NULL,

  -- Acceptance
  accepted_at       TIMESTAMPTZ  DEFAULT NULL,
  accepted_user_id  BIGINT       DEFAULT NULL REFERENCES organizer_users(id) ON DELETE SET NULL,

  -- Revocation
  revoked_at        TIMESTAMPTZ  DEFAULT NULL,
  revoked_by_user_id BIGINT      DEFAULT NULL REFERENCES organizer_users(id) ON DELETE SET NULL,

  -- Timestamps
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_invitations_token_hash
  ON manager_invitations (token_hash);

CREATE INDEX IF NOT EXISTS idx_manager_invitations_org
  ON manager_invitations (organization_id);

CREATE INDEX IF NOT EXISTS idx_manager_invitations_email
  ON manager_invitations (organization_id, email);

CREATE INDEX IF NOT EXISTS idx_manager_invitations_expires
  ON manager_invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Auto-update
CREATE OR REPLACE FUNCTION manager_invitations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_manager_invitations_updated_at'
  ) THEN
    CREATE TRIGGER trg_manager_invitations_updated_at
      BEFORE UPDATE ON manager_invitations
      FOR EACH ROW
      EXECUTE FUNCTION manager_invitations_set_updated_at();
  END IF;
END $$;


-- ── 2. Event revenue helper: computed revenue per event ───────────────────────
-- We add a generated view for analytics aggregation. This avoids expensive
-- joins at query time and keeps the revenue source of truth on bookings +
-- ticket_tiers.

CREATE OR REPLACE VIEW v_event_revenue AS
SELECT
  e.id                        AS event_id,
  e.organization_id,
  e.title                     AS event_title,
  COALESCE(SUM(
    CASE WHEN b.status = 'confirmed' OR b.status = 'attended'
    THEN b.ticket_count * COALESCE(
      (SELECT AVG(tt.price)
       FROM ticket_tiers tt
       WHERE tt.event_id = e.id AND tt.type = 'general'),
      0)
    ELSE 0 END
  ), 0)                       AS total_revenue,
  COUNT(DISTINCT CASE WHEN b.status = 'confirmed' OR b.status = 'attended'
    THEN b.id END)           AS total_confirmed_bookings,
  COUNT(DISTINCT b.id)       AS total_bookings,
  e.created_at,
  e.start_at,
  e.end_at,
  e.category,
  e.city,
  e.venue_name
FROM events e
LEFT JOIN bookings b ON b.event_id = e.id
WHERE e.deleted_at IS NULL
GROUP BY e.id, e.organization_id, e.title, e.created_at, e.start_at, e.end_at,
         e.category, e.city, e.venue_name;

-- ANALYZE
ANALYZE manager_invitations;
