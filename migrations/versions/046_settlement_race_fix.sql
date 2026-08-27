-- ============================================================================
-- Migration 046: Settlement race condition fixes
-- ============================================================================
-- Fixes:
--   1. Unique partial index so only ONE pending settlement per organization
--   2. Unique index on booking_id in settlement items to prevent duplicate items
--   3. Composite indexes for findPendingByOrg performance
-- ============================================================================

-- Unique partial index: only one 'pending' settlement per organization
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_settlements_org_pending
  ON event_settlements(organization_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_settlements_org_pending
  ON turf_settlements(organization_id)
  WHERE status = 'pending';

-- Unique index on booking_id to prevent duplicate settlement items (race condition fix)
-- NOTE: existing composite indexes (uq_*_item_booking on settlement_id+booking_id) remain
-- These new indexes prevent the same booking appearing in ANY settlement item
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_settlement_item_booking_id
  ON event_settlement_items(booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_settlement_item_booking_id
  ON turf_settlement_items(booking_id);

-- Composite indexes for findPendingByOrg queries (status + scheduled_at)
CREATE INDEX IF NOT EXISTS idx_event_settlements_pending_scheduled
  ON event_settlements(status, scheduled_at, net_amount, retry_count, max_retries)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_turf_settlements_pending_scheduled
  ON turf_settlements(status, scheduled_at, net_amount, retry_count, max_retries)
  WHERE status = 'pending';
