-- ============================================================================
-- Migration 025 — Financial Configuration
-- ============================================================================
-- Configurable GST rates, platform fees, and commission structures.
-- ============================================================================

CREATE TABLE IF NOT EXISTS financial_configs (
  id                  SERIAL PRIMARY KEY,
  config_type         VARCHAR(30)  NOT NULL
    CHECK (config_type IN ('gst', 'platform_fee', 'commission', 'tds', 'cancellation_fee', 'payout_minimum')),
  scope               VARCHAR(20)  NOT NULL DEFAULT 'global'
    CHECK (scope IN ('global', 'organization')),
  organization_id     INT          DEFAULT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  value_bps           INT          NOT NULL,
  value_paise         INT          DEFAULT NULL,
  applies_to          VARCHAR(30)  NOT NULL DEFAULT 'all'
    CHECK (applies_to IN ('all', 'turf', 'event', 'booking', 'settlement')),
  effective_date      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ  DEFAULT NULL,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  created_by_admin_id INT          DEFAULT NULL REFERENCES admins(id),
  notes               TEXT         DEFAULT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Partial unique index: enforce one active config per (type, scope, org)
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_config_active
  ON financial_configs (config_type, scope, organization_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_financial_configs_type
  ON financial_configs (config_type, is_active)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_financial_configs_org
  ON financial_configs (organization_id)
  WHERE scope = 'organization' AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_financial_configs_effective
  ON financial_configs (effective_date)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION financial_configs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_financial_configs_updated_at'
  ) THEN
    CREATE TRIGGER trg_financial_configs_updated_at
      BEFORE UPDATE ON financial_configs
      FOR EACH ROW
      EXECUTE FUNCTION financial_configs_set_updated_at();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM financial_configs WHERE is_active = true) THEN
    INSERT INTO financial_configs (config_type, scope, value_bps, applies_to, notes) VALUES
      ('gst',               'global', 1800, 'settlement', '18% GST on platform fees'),
      ('platform_fee',      'global',  500, 'all',        '5% platform fee on gross booking'),
      ('commission',        'global', 1000, 'all',        '10% commission to platform'),
      ('tds',               'global',    0, 'settlement', '0% TDS on payouts'),
      ('cancellation_fee',  'global', 5000, 'booking',    'Flat cancellation fee INR 50'),
      ('payout_minimum',    'global', 50000, 'settlement', 'Minimum payout INR 500')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

ANALYZE financial_configs;
