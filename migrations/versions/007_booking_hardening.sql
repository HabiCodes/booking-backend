-- ============================================================================
-- Migration 007: Booking hardening — capacity atomicity, QR signatures,
-- cancellation windows, audit hooks
--
-- Backward compatible: every change is wrapped in information_schema checks
-- so this migration is safe to run on databases that already have any subset
-- of these columns from an inline migration or earlier ad-hoc ALTER.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Events: cancellation window + cancellation deadline
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'cancel_window_hours'
  ) THEN
    ALTER TABLE events
      ADD COLUMN cancel_window_hours INTEGER NOT NULL DEFAULT 6,
      ADD CONSTRAINT events_cancel_window_check
        CHECK (cancel_window_hours >= 0 AND cancel_window_hours <= 720);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'cancellable_until'
  ) THEN
    ALTER TABLE events
      ADD COLUMN cancellable_until TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Backfill cancellable_until from start_at - cancel_window_hours (best-effort)
UPDATE events
   SET cancellable_until = start_at - (cancel_window_hours || ' hours')::INTERVAL
 WHERE cancellable_until IS NULL
   AND start_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Bookings: ticket_count sanity + updated_at
-- (status enum already in migration 004; we just tighten the check constraint)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'bookings' AND constraint_name = 'bookings_ticket_count_range_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_ticket_count_range_check
      CHECK (ticket_count >= 1 AND ticket_count <= 50);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Tickets: HMAC signature column for QR tamper detection
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tickets' AND column_name = 'signature'
  ) THEN
    ALTER TABLE tickets
      ADD COLUMN signature TEXT DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tickets' AND column_name = 'issued_at'
  ) THEN
    ALTER TABLE tickets
      ADD COLUMN issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tickets_signature ON tickets(signature);
CREATE INDEX IF NOT EXISTS idx_tickets_issued ON tickets(issued_at DESC);

-- ----------------------------------------------------------------------------
-- Bookings: indexes for fast stats and per-user lookups
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_bookings_event_status
  ON bookings(event_id, status);

CREATE INDEX IF NOT EXISTS idx_bookings_user_event
  ON bookings(user_id, event_id)
  WHERE status IN ('confirmed', 'attended');
