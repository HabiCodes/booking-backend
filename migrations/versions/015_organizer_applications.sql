-- ============================================================================
-- Migration 015: Organizer Applications
-- ============================================================================
-- Public-facing application form for event organizers.
-- Lifecycle: pending → approved → provisioned (creates org + owner account)
--            pending → soft_rejected → organizer edits → pending (resubmit)
--            pending → hard_rejected → locked (only Super Admin can reopen)
--
-- IMPORTANT:
--  - All "optional" fields are nullable so registration cannot fail for
--    missing optional data.
--  - KYC is NOT mandatory in this phase.
--  - Cashfree credentials are NOT stored here — see migration 016.
-- ============================================================================

-- ── organizer_applications ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizer_applications (
  id                       BIGSERIAL PRIMARY KEY,

  -- ── Business information (required for review) ────────────────────────────
  legal_name               VARCHAR(255) NOT NULL,
  display_name             VARCHAR(255) NOT NULL,
  email                    VARCHAR(255) NOT NULL UNIQUE,
  phone                    VARCHAR(30)  DEFAULT NULL,
  business_address         TEXT         DEFAULT NULL,
  city                     VARCHAR(120) DEFAULT NULL,
  state                    VARCHAR(120) DEFAULT NULL,
  country                  VARCHAR(120) DEFAULT 'India',

  -- ── Optional tax/identity ─────────────────────────────────────────────────
  gst_tax_id               VARCHAR(50)  DEFAULT NULL,
  pan                      VARCHAR(20)  DEFAULT NULL,

  -- ── Optional documents (URLs to uploaded files) ───────────────────────────
  identity_document_url    VARCHAR(512) DEFAULT NULL,
  business_document_url    VARCHAR(512) DEFAULT NULL,
  supporting_document_urls JSONB        DEFAULT '[]'::jsonb,

  -- ── Optional banking (for future payout integration) ─────────────────────
  account_holder_name      VARCHAR(255) DEFAULT NULL,
  bank_details             JSONB        DEFAULT '{}'::jsonb,
  payout_details           JSONB        DEFAULT '{}'::jsonb,

  -- ── Optional branding ─────────────────────────────────────────────────────
  logo_url                 VARCHAR(512) DEFAULT NULL,
  description              TEXT         DEFAULT NULL,
  branding_metadata        JSONB        DEFAULT '{}'::jsonb,

  -- ── Application status ────────────────────────────────────────────────────
  -- 'pending' | 'approved' | 'soft_rejected' | 'hard_rejected'
  status                   VARCHAR(20)  NOT NULL DEFAULT 'pending',

  -- ── Review fields (null until a Super Admin acts) ─────────────────────────
  rejection_type           VARCHAR(10)  DEFAULT NULL CHECK (rejection_type IN ('soft', 'hard')),
  rejection_reason         TEXT         DEFAULT NULL,
  reviewed_by              BIGINT       DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at              TIMESTAMPTZ  DEFAULT NULL,

  -- ── Hard rejection lock ────────────────────────────────────────────────────
  hard_rejected_by         BIGINT       DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  hard_rejected_at         TIMESTAMPTZ  DEFAULT NULL,

  -- ── Provisioning (filled after approval) ──────────────────────────────────
  organization_id          BIGINT       DEFAULT NULL,

  -- ── Timestamps ─────────────────────────────────────────────────────────────
  submitted_at             TIMESTAMPTZ  DEFAULT NULL,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_applications_status
  ON organizer_applications (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_applications_email
  ON organizer_applications (email);

CREATE INDEX IF NOT EXISTS idx_organizer_applications_org
  ON organizer_applications (organization_id)
  WHERE organization_id IS NOT NULL;

-- Status constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'organizer_applications'::regclass
      AND conname = 'organizer_applications_status_check'
  ) THEN
    ALTER TABLE organizer_applications
      ADD CONSTRAINT organizer_applications_status_check
      CHECK (status IN ('pending', 'approved', 'soft_rejected', 'hard_rejected'));
  END IF;
END $$;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION organizer_applications_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_organizer_applications_updated_at'
  ) THEN
    CREATE TRIGGER trg_organizer_applications_updated_at
      BEFORE UPDATE ON organizer_applications
      FOR EACH ROW
      EXECUTE FUNCTION organizer_applications_set_updated_at();
  END IF;
END $$;

-- ── organizer_application_history: append-only audit trail ────────────────────

CREATE TABLE IF NOT EXISTS organizer_application_history (
  id              BIGSERIAL PRIMARY KEY,
  application_id  BIGINT NOT NULL REFERENCES organizer_applications(id) ON DELETE CASCADE,

  from_status     VARCHAR(20) DEFAULT NULL
    CHECK (from_status IS NULL OR from_status IN ('pending', 'approved', 'soft_rejected', 'hard_rejected')),
  to_status       VARCHAR(20) NOT NULL
    CHECK (to_status IN ('pending', 'approved', 'soft_rejected', 'hard_rejected')),

  reason          TEXT         DEFAULT NULL,
  actor_admin_id  BIGINT       DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,

  metadata        JSONB        DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_app_hist_application
  ON organizer_application_history (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_app_hist_actor
  ON organizer_application_history (actor_admin_id)
  WHERE actor_admin_id IS NOT NULL;

-- ANALYZE
ANALYZE organizer_applications;
ANALYZE organizer_application_history;
