-- ============================================================================
-- Migration 029 — Cancellation Requests + Global Refund Policy
-- ============================================================================
-- Phase 1 of refund architecture.
--
-- Creates two tables:
--   1. refund_policies       — Super Admin configures time-based refund slabs
--   2. cancellation_requests — the immutable financial decision for a booking
--
-- Business rules enforced:
--   - ONE booking = ONE cancellation decision (UNIQUE on booking_id)
--   - Cancellation request freezes the calculated refund percentage/amount
--   - Admin override is allowed (up or down)
--   - Financial invariants: refund_amount >= 0, percentage 0..100
--
-- Cashfree refund execution is NOT implemented in this migration.
-- Phase 2 will add the refunds row + idempotency_key + execution flow.
-- ============================================================================

BEGIN;

-- ── Refund Policies (Global slabs) ──────────────────────────────────────────
-- One global policy for Phase 1. Schema is extensible: a future
-- scope/active_version pair can support org-level or versioned policies.

CREATE TABLE IF NOT EXISTS refund_policies (
  id                   BIGSERIAL    PRIMARY KEY,

  -- Extensibility fields (Phase 1 uses only scope='global', version=1)
  scope                VARCHAR(20)  NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global', 'organization')),
  organization_id      BIGINT       DEFAULT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  version              INTEGER      NOT NULL DEFAULT 1,

  -- The slab definition
  hours_before         NUMERIC(6, 2) NOT NULL,
  refund_percentage    NUMERIC(5, 2) NOT NULL,

  -- Lifecycle
  is_active            BOOLEAN      NOT NULL DEFAULT true,
  notes                TEXT         DEFAULT NULL,

  -- Audit
  created_by_admin_id  INTEGER      DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT refund_policies_hours_before_nonneg
    CHECK (hours_before >= 0),
  CONSTRAINT refund_policies_percentage_range
    CHECK (refund_percentage >= 0 AND refund_percentage <= 100)
);

-- One active slab per (scope, organization_id, version, hours_before).
-- Multiple is_active=false rows allowed (history) but only one active per
-- (scope, organization_id, hours_before).
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_policies_active_slab
  ON refund_policies (scope, organization_id, hours_before)
  WHERE is_active = true;

-- Lookup index for the resolver function
CREATE INDEX IF NOT EXISTS idx_refund_policies_lookup
  ON refund_policies (scope, organization_id, is_active, hours_before DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION refund_policies_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_refund_policies_updated_at ON refund_policies;
CREATE TRIGGER trg_refund_policies_updated_at
  BEFORE UPDATE ON refund_policies
  FOR EACH ROW EXECUTE FUNCTION refund_policies_set_updated_at();

-- Seed the global default policy slabs (idempotent).
-- 48h+ → 90%, 24h+ → 75%, 12h+ → 50%, 0h+ → 0%.
INSERT INTO refund_policies (scope, organization_id, version, hours_before, refund_percentage, is_active, notes)
SELECT 'global', NULL, 1, v.hours_before, v.refund_percentage, true, v.notes
FROM (VALUES
  (48.00, 90.00, 'Default global: 48h+ before event → 90% refund'),
  (24.00, 75.00, 'Default global: 24h+ before event → 75% refund'),
  (12.00, 50.00, 'Default global: 12h+ before event → 50% refund'),
  ( 0.00,  0.00, 'Default global: less than 12h or past start → 0% refund')
) AS v(hours_before, refund_percentage, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM refund_policies
  WHERE scope = 'global'
    AND organization_id IS NULL
    AND hours_before = v.hours_before
    AND is_active = true
);


-- ── Cancellation Requests ────────────────────────────────────────────────────
-- The single source of truth for "what refund does this booking get".
-- One row per booking (UNIQUE booking_id).
--
-- The frozen financial snapshot is computed AT REQUEST TIME and is
-- NEVER recalculated from the live policy table later.

CREATE TABLE IF NOT EXISTS cancellation_requests (
  id                            BIGSERIAL    PRIMARY KEY,

  -- Identity / links
  booking_id                    BIGINT       NOT NULL
    REFERENCES bookings(id) ON DELETE RESTRICT,
  payment_order_id              BIGINT       NOT NULL
    REFERENCES payment_orders(id) ON DELETE RESTRICT,
  organization_id               BIGINT       NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,

  -- Who requested
  requested_by                  BIGINT       NOT NULL
    REFERENCES users(id) ON DELETE RESTRICT,
  requested_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason                        TEXT         DEFAULT NULL,

  -- Frozen policy snapshot (immutable after insert)
  hours_before_event            NUMERIC(6, 2) NOT NULL,
  policy_id                     BIGINT       DEFAULT NULL
    REFERENCES refund_policies(id) ON DELETE SET NULL,
  calculated_refund_percentage  NUMERIC(5, 2) NOT NULL,
  calculated_refund_amount_paise BIGINT      NOT NULL,

  -- Approval
  status                        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  approved_by_admin_id          INTEGER      DEFAULT NULL
    REFERENCES admins(id) ON DELETE SET NULL,
  approved_at                   TIMESTAMPTZ  DEFAULT NULL,
  approved_refund_percentage    NUMERIC(5, 2) DEFAULT NULL,
  approved_refund_amount_paise  BIGINT       DEFAULT NULL,
  override_reason               TEXT         DEFAULT NULL,
  rejection_reason              TEXT         DEFAULT NULL,

  -- Future-phase link: filled when refund execution creates the actual refund row
  refund_id                     BIGINT       DEFAULT NULL
    REFERENCES refunds(id) ON DELETE SET NULL,

  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT cancellation_requests_hours_nonneg
    CHECK (hours_before_event >= 0),
  CONSTRAINT cancellation_requests_calc_pct_range
    CHECK (calculated_refund_percentage >= 0 AND calculated_refund_percentage <= 100),
  CONSTRAINT cancellation_requests_calc_amount_nonneg
    CHECK (calculated_refund_amount_paise >= 0),
  CONSTRAINT cancellation_requests_approved_pct_range
    CHECK (approved_refund_percentage IS NULL
       OR (approved_refund_percentage >= 0 AND approved_refund_percentage <= 100)),
  CONSTRAINT cancellation_requests_approved_amount_nonneg
    CHECK (approved_refund_amount_paise IS NULL OR approved_refund_amount_paise >= 0),
  CONSTRAINT cancellation_requests_approved_percentage_required
    CHECK ((approved_refund_percentage IS NULL) = (approved_refund_amount_paise IS NULL)),
  CONSTRAINT cancellation_requests_one_decision_per_booking
    UNIQUE (booking_id)
);

CREATE INDEX IF NOT EXISTS idx_cancellation_requests_status
  ON cancellation_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cancellation_requests_payment_order
  ON cancellation_requests (payment_order_id);

CREATE INDEX IF NOT EXISTS idx_cancellation_requests_org_status
  ON cancellation_requests (organization_id, status, created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION cancellation_requests_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cancellation_requests_updated_at ON cancellation_requests;
CREATE TRIGGER trg_cancellation_requests_updated_at
  BEFORE UPDATE ON cancellation_requests
  FOR EACH ROW EXECUTE FUNCTION cancellation_requests_set_updated_at();

COMMIT;
