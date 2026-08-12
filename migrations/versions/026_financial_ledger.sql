-- ============================================================================
-- Migration 026 — Financial Ledger
-- ============================================================================
-- Immutable double-entry ledger.  Never UPDATE/DELETE — use reversal entries.
-- ============================================================================

CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  id                  SERIAL PRIMARY KEY,
  organization_id     INT          DEFAULT NULL
    REFERENCES organizations(id) ON DELETE SET NULL,
  entry_type          VARCHAR(30)  NOT NULL
    CHECK (entry_type IN (
      'payment_received','refund_issued','platform_fee','gst_collected',
      'gst_refunded','commission_earned','commission_reversed',
      'settlement_paid','cancellation_fee','coupon_discount',
      'ad_revenue','sponsorship_revenue','platform_fee_refunded','adjustment'
    )),
  direction           VARCHAR(10)  NOT NULL
    CHECK (direction IN ('debit', 'credit')),
  amount_paise        BIGINT       NOT NULL CHECK (amount_paise >= 0),
  currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',
  reference_type      VARCHAR(30)  NOT NULL
    CHECK (reference_type IN (
      'booking','refund','settlement','coupon','advertisement',
      'sponsorship','payment_order','adjustment','cancellation'
    )),
  reference_id        INT          NOT NULL,
  idempotency_key     VARCHAR(128) NOT NULL,
  config_snapshot     JSONB        DEFAULT '{}'::jsonb,
  metadata            JSONB        DEFAULT '{}'::jsonb,
  is_reversed         BOOLEAN      NOT NULL DEFAULT false,
  reversed_by_id      INT          DEFAULT NULL
    REFERENCES financial_ledger_entries(id) ON DELETE SET NULL,
  reversal_reason     TEXT         DEFAULT NULL,
  posted_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ledger_no_self_reverse CHECK (id != reversed_by_id)
);

-- Partial unique index: prevent duplicate non-reversed entries for the same reference
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_active_event
  ON financial_ledger_entries (entry_type, reference_type, reference_id)
  WHERE is_reversed = false;

CREATE INDEX IF NOT EXISTS idx_ledger_org_date
  ON financial_ledger_entries (organization_id, posted_at DESC)
  WHERE is_reversed = false;
CREATE INDEX IF NOT EXISTS idx_ledger_reference
  ON financial_ledger_entries (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_type
  ON financial_ledger_entries (entry_type, posted_at DESC)
  WHERE is_reversed = false;
CREATE INDEX IF NOT EXISTS idx_ledger_idempotency
  ON financial_ledger_entries (idempotency_key)
  WHERE is_reversed = false;

CREATE TABLE IF NOT EXISTS financial_adjustments (
  id                  SERIAL PRIMARY KEY,
  admin_id            INT          NOT NULL REFERENCES admins(id),
  organization_id     INT          DEFAULT NULL
    REFERENCES organizations(id) ON DELETE SET NULL,
  adjustment_type     VARCHAR(30)  NOT NULL
    CHECK (adjustment_type IN (
      'settlement_correction','fee_waiver','penalty','bonus','other'
    )),
  amount_paise        BIGINT       NOT NULL,
  currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',
  reference_type      VARCHAR(30)  DEFAULT NULL,
  reference_id        INT          DEFAULT NULL,
  reason              TEXT         NOT NULL,
  approved_by_admin_id INT         DEFAULT NULL REFERENCES admins(id),
  approved_at         TIMESTAMPTZ  DEFAULT NULL,
  metadata            JSONB        DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_adjustment_positive CHECK (amount_paise > 0)
);

CREATE INDEX IF NOT EXISTS idx_financial_adjustments_org
  ON financial_adjustments (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_adjustments_admin
  ON financial_adjustments (admin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS financial_report_snapshots (
  id                  SERIAL PRIMARY KEY,
  organization_id     INT          DEFAULT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  report_date         DATE         NOT NULL,
  total_bookings      INT          NOT NULL DEFAULT 0,
  total_gross_amount  BIGINT       NOT NULL DEFAULT 0,
  total_gst           BIGINT       NOT NULL DEFAULT 0,
  total_platform_fee  BIGINT       NOT NULL DEFAULT 0,
  total_commission    BIGINT       NOT NULL DEFAULT 0,
  total_tds           BIGINT       NOT NULL DEFAULT 0,
  total_coupon_discount BIGINT     NOT NULL DEFAULT 0,
  total_cancellation_fee BIGINT    NOT NULL DEFAULT 0,
  total_refunded      BIGINT       NOT NULL DEFAULT 0,
  total_net_payable   BIGINT       NOT NULL DEFAULT 0,
  total_settled       BIGINT       NOT NULL DEFAULT 0,
  total_pending       BIGINT       NOT NULL DEFAULT 0,
  total_ad_revenue    BIGINT       NOT NULL DEFAULT 0,
  total_sponsorship_revenue BIGINT NOT NULL DEFAULT 0,
  total_adjustments   BIGINT       NOT NULL DEFAULT 0,
  currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_report_snapshot_org_date UNIQUE (organization_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_report_snapshots_org_date
  ON financial_report_snapshots (organization_id, report_date DESC);

CREATE OR REPLACE FUNCTION financial_report_snapshots_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_financial_report_snapshots_updated_at'
  ) THEN
    CREATE TRIGGER trg_financial_report_snapshots_updated_at
      BEFORE UPDATE ON financial_report_snapshots
      FOR EACH ROW
      EXECUTE FUNCTION financial_report_snapshots_set_updated_at();
  END IF;
END $$;

ANALYZE financial_ledger_entries;
ANALYZE financial_adjustments;
ANALYZE financial_report_snapshots;
