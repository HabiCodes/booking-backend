-- ============================================================================
-- Migration 018: Analytics helper indexes + organizer approval idempotency
-- ============================================================================

-- Composite index for the organizer dashboard "events by status" query
CREATE INDEX IF NOT EXISTS idx_events_org_status
  ON events (organization_id, status)
  WHERE organization_id IS NOT NULL AND deleted_at IS NULL;

-- Composite index for bookings by event for analytics aggregation
CREATE INDEX IF NOT EXISTS idx_bookings_event_created
  ON bookings (event_id, created_at DESC);

-- Composite index for tickets by booking (for tier-level analytics)
CREATE INDEX IF NOT EXISTS idx_tickets_booking
  ON tickets (booking_id);

-- organizer_audit_logs — mirrors audit_logs but tracks organizer-side actions
CREATE TABLE IF NOT EXISTS organizer_audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id   BIGINT DEFAULT NULL REFERENCES organizer_users(id) ON DELETE SET NULL,
  actor_type      VARCHAR(20) NOT NULL DEFAULT 'organizer_user'
    CHECK (actor_type IN ('organizer_user', 'system')),

  action          VARCHAR(80) NOT NULL,
  entity_type     VARCHAR(50) DEFAULT NULL,
  entity_id       BIGINT DEFAULT NULL,

  metadata        JSONB        DEFAULT '{}'::jsonb,
  ip_address      VARCHAR(45)  DEFAULT NULL,
  user_agent      TEXT         DEFAULT NULL,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_audit_org_time
  ON organizer_audit_logs (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_audit_actor
  ON organizer_audit_logs (actor_user_id)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_organizer_audit_entity
  ON organizer_audit_logs (entity_type, entity_id);

-- ANALYZE
ANALYZE organizer_audit_logs;
