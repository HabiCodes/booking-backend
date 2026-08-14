-- ============================================================================
-- Migration 030 — Manual Payment Flow for Cancellation Requests
-- ============================================================================
-- Extends migration 029 to support the full cancellation request lifecycle:
--   PENDING → APPROVED → READY_FOR_MANUAL_PAYMENT → PAID
--
-- Changes:
--   1. Extends cancellation_requests status CHECK to include new statuses
--   2. Creates manual_payments table with unique constraint per cancellation request
-- ============================================================================

BEGIN;

-- ── 1. Extend cancellation_requests status CHECK ──────────────────────────────
-- Drop the old CHECK constraint and replace it with the extended set.
-- We find the auto-generated constraint name from pg_constraint.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'cancellation_requests'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%PENDING%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE cancellation_requests DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE cancellation_requests
  ADD CONSTRAINT cancellation_requests_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN',
                    'READY_FOR_MANUAL_PAYMENT', 'PAID'));

-- ── 2. Manual Payments ────────────────────────────────────────────────────────
-- One record per cancellation request (UNIQUE on cancellation_request_id).
-- Stores the UPI / manual transfer details recorded by the admin.

CREATE TABLE IF NOT EXISTS manual_payments (
  id                      BIGSERIAL    PRIMARY KEY,

  -- Link to the cancellation request (UNIQUE — one payment per request)
  cancellation_request_id BIGINT       NOT NULL
    REFERENCES cancellation_requests(id) ON DELETE RESTRICT,

  -- Payment details recorded by the admin
  customer_upi_id         VARCHAR(255) NOT NULL,
  amount_paise            BIGINT       NOT NULL,
  transaction_ref_id      VARCHAR(255) NOT NULL,
  payment_date            DATE         NOT NULL,
  paid_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Auditor
  created_by_admin_id     BIGINT       NOT NULL
    REFERENCES admins(id) ON DELETE RESTRICT,

  -- Timestamps
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT manual_payments_amount_nonneg
    CHECK (amount_paise >= 0)
);

-- One manual payment per cancellation request — enforced at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_payments_request
  ON manual_payments (cancellation_request_id);

-- Lookup index for admin queries by cancellation request
CREATE INDEX IF NOT EXISTS idx_manual_payments_request
  ON manual_payments (cancellation_request_id);

-- Lookup index for admin queries by who recorded the payment
CREATE INDEX IF NOT EXISTS idx_manual_payments_admin
  ON manual_payments (created_by_admin_id, created_at DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION manual_payments_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_manual_payments_updated_at ON manual_payments;
CREATE TRIGGER trg_manual_payments_updated_at
  BEFORE UPDATE ON manual_payments
  FOR EACH ROW EXECUTE FUNCTION manual_payments_set_updated_at();

COMMIT;
