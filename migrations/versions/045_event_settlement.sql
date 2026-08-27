-- ============================================================================
-- Migration 045: Event settlement infrastructure
-- ============================================================================

-- ── Event Settlements ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_settlements (
    id                  SERIAL PRIMARY KEY,
    organization_id     BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    gross_amount        NUMERIC(12,2) DEFAULT 0,
    commission_amount   NUMERIC(12,2) DEFAULT 0,
    tax_amount          NUMERIC(12,2) DEFAULT 0,
    net_amount          NUMERIC(12,2) DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'pending',
    gateway_payout_id   VARCHAR(200),
    scheduled_at        TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours',
    completed_at        TIMESTAMPTZ,
    failure_reason      TEXT,
    retry_count         INT DEFAULT 0,
    max_retries         INT DEFAULT 3,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_settlements_org ON event_settlements(organization_id);
CREATE INDEX IF NOT EXISTS idx_event_settlements_status ON event_settlements(status);

-- ── Event Settlement Items ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_settlement_items (
    id                  SERIAL PRIMARY KEY,
    settlement_id       INT NOT NULL REFERENCES event_settlements(id) ON DELETE CASCADE,
    booking_id          INT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    gross_amount        NUMERIC(10,2) NOT NULL,
    commission_amount   NUMERIC(10,2) NOT NULL,
    tax_amount          NUMERIC(10,2) NOT NULL,
    net_amount          NUMERIC(10,2) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_settlement_items_settlement ON event_settlement_items(settlement_id);
CREATE INDEX IF NOT EXISTS idx_event_settlement_items_booking ON event_settlement_items(booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_settlement_item_booking ON event_settlement_items(settlement_id, booking_id);
