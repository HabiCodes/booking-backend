-- ============================================================================
-- Migration 004: Bookings + tickets + audit logs
-- Adds: status, cancelled_at, audit log table for booking actions
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'status') THEN
    ALTER TABLE bookings ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'confirmed';
    ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
      CHECK (status IN ('pending', 'confirmed', 'cancelled', 'attended'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'cancelled_at') THEN
    ALTER TABLE bookings ADD COLUMN cancelled_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'cancellation_reason') THEN
    ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'updated_at') THEN
    ALTER TABLE bookings ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bookings' AND column_name = 'deleted_at') THEN
    ALTER TABLE bookings ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Ticket-level soft delete
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tickets' AND column_name = 'deleted_at') THEN
    ALTER TABLE tickets ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Booking audit logs (covers bookings, cancellations, check-ins)
CREATE TABLE IF NOT EXISTS booking_audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  booking_id    BIGINT DEFAULT NULL REFERENCES bookings(id) ON DELETE SET NULL,
  ticket_id     BIGINT DEFAULT NULL REFERENCES tickets(id) ON DELETE SET NULL,
  actor_type    VARCHAR(20) NOT NULL,
  actor_id      BIGINT DEFAULT NULL,
  action        VARCHAR(50) NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_audit_booking ON booking_audit_logs(booking_id);
CREATE INDEX IF NOT EXISTS idx_booking_audit_action_time ON booking_audit_logs(action, created_at DESC);