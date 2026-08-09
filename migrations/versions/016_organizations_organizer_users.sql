-- ============================================================================
-- Migration 016: Organizations + Organizer Users + multi-tenant event ownership
-- ============================================================================
--
-- Tables:
--   1. organizations           — tenant/workspace for each approved organizer
--   2. organizer_users         — accounts within an organization (owner + managers)
--   3. organizer_password_tokens  — one-time tokens for initial password setup
--
-- Extensions:
--   - events.organization_id  — FK to organizations (nullable for legacy admin events)
-- ============================================================================


-- ── 1. organizations ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id                BIGSERIAL PRIMARY KEY,

  -- Identity
  name               VARCHAR(255) NOT NULL,
  display_name       VARCHAR(255) NOT NULL,
  slug               VARCHAR(120) NOT NULL UNIQUE,

  -- Contact
  email              VARCHAR(255) DEFAULT NULL,
  phone              VARCHAR(30)  DEFAULT NULL,
  address            TEXT         DEFAULT NULL,
  city               VARCHAR(120) DEFAULT NULL,
  state              VARCHAR(120) DEFAULT NULL,
  country            VARCHAR(120) DEFAULT 'India',

  -- Branding
  logo_url           VARCHAR(512) DEFAULT NULL,
  description        TEXT         DEFAULT NULL,
  branding_metadata  JSONB        DEFAULT '{}'::jsonb,

  -- Banking / payout (nullable — KYC optional)
  bank_details       JSONB        DEFAULT '{}'::jsonb,
  payout_details     JSONB        DEFAULT '{}'::jsonb,

  -- Status
  is_active          BOOLEAN      NOT NULL DEFAULT true,

  -- Provisioning
  application_id     BIGINT       DEFAULT NULL REFERENCES organizer_applications(id) ON DELETE SET NULL,

  -- Timestamps
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug
  ON organizations (slug);

CREATE INDEX IF NOT EXISTS idx_organizations_active
  ON organizations (is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_organizations_application
  ON organizations (application_id)
  WHERE application_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION organizations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_organizations_updated_at'
  ) THEN
    CREATE TRIGGER trg_organizations_updated_at
      BEFORE UPDATE ON organizations
      FOR EACH ROW
      EXECUTE FUNCTION organizations_set_updated_at();
  END IF;
END $$;


-- ── 2. organizer_users ────────────────────────────────────────────────────────
-- Separate from admins (super_admin/admin) AND users (public ticket buyers).
-- Organizer users authenticate with a DIFFERENT JWT (organizer_secret).
--
-- Roles: 'owner' | 'manager'
-- Permissions are managed via the JSONB `permissions` column.

CREATE TABLE IF NOT EXISTS organizer_users (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  email           VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  name            VARCHAR(255) NOT NULL,
  phone           VARCHAR(30)  DEFAULT NULL,

  -- 'owner' = organization owner (full access within tenant)
  -- 'manager' = staff member (limited permissions)
  role            VARCHAR(20)  NOT NULL DEFAULT 'manager'
    CHECK (role IN ('owner', 'manager')),

  -- Granular permissions (JSONB). Managed by Super Admin or org owner.
  permissions     JSONB        NOT NULL DEFAULT '{}'::jsonb,

  -- Account status
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  must_change_password BOOLEAN NOT NULL DEFAULT false,

  last_login_at   TIMESTAMPTZ  DEFAULT NULL,

  -- Timestamps
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One active owner per organization (enforced by partial unique index)
  CONSTRAINT uq_organizer_users_org_email UNIQUE (organization_id, email)
);

CREATE INDEX IF NOT EXISTS idx_organizer_users_email
  ON organizer_users (email)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_organizer_users_organization
  ON organizer_users (organization_id);

CREATE INDEX IF NOT EXISTS idx_organizer_users_role
  ON organizer_users (organization_id, role);

-- Ensure exactly one owner per organization (partial unique on role = 'owner')
CREATE UNIQUE INDEX IF NOT EXISTS uq_organizer_users_one_owner_per_org
  ON organizer_users (organization_id)
  WHERE role = 'owner' AND is_active = true;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION organizer_users_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_organizer_users_updated_at'
  ) THEN
    CREATE TRIGGER trg_organizer_users_updated_at
      BEFORE UPDATE ON organizer_users
      FOR EACH ROW
      EXECUTE FUNCTION organizer_users_set_updated_at();
  END IF;
END $$;


-- ── 3. organizer_password_tokens ──────────────────────────────────────────────
-- One-time tokens for the initial password setup flow.
-- Sent to the organizer's email after Super Admin approval.
-- Single-use, expires, cryptographically random.

CREATE TABLE IF NOT EXISTS organizer_password_tokens (
  id            BIGSERIAL PRIMARY KEY,
  organizer_user_id BIGINT NOT NULL REFERENCES organizer_users(id) ON DELETE CASCADE,

  -- SHA-256 hash of the token (never store plaintext)
  token_hash    VARCHAR(64) NOT NULL,

  -- Timestamps
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ DEFAULT NULL,

  -- Audit
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizer_pw_tokens_hash
  ON organizer_password_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_organizer_pw_tokens_user
  ON organizer_password_tokens (organizer_user_id, used_at);

CREATE INDEX IF NOT EXISTS idx_organizer_pw_tokens_expires
  ON organizer_password_tokens (expires_at)
  WHERE used_at IS NULL;


-- ── 4. Extend events with organization_id ─────────────────────────────────────
-- Nullable because existing admin-created events don't have an org.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'organization_id'
  ) THEN
    ALTER TABLE events ADD COLUMN organization_id BIGINT DEFAULT NULL
      REFERENCES organizations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_organization_id
  ON events (organization_id)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;


-- ── 5. Extend events with organizer-level status ──────────────────────────────
-- organizer_status: null (admin event) | 'draft' | 'submitted' | 'approved' | 'rejected'
-- This is separate from the admin event_status and is used for the organizer
-- approval workflow.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'organizer_status'
  ) THEN
    ALTER TABLE events ADD COLUMN organizer_status VARCHAR(20) DEFAULT NULL
      CHECK (organizer_status IS NULL OR organizer_status IN ('draft', 'submitted', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_organizer_status
  ON events (organization_id, organizer_status)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;


-- ── ANALYZE ───────────────────────────────────────────────────────────────────

ANALYZE organizations;
ANALYZE organizer_users;
ANALYZE organizer_password_tokens;
ANALYZE events;
