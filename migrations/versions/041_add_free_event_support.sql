-- Migration 041: Add free event support and booking status for payment pending
-- Date: 2026-08-25

-- Add is_free column to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT FALSE NOT NULL;

-- Add CHECK constraint: free events must have price = 0
ALTER TABLE events ADD CONSTRAINT events_free_price_check
  CHECK (NOT is_free OR price = 0);

-- Add booking status for payment pending (paid events awaiting payment)
-- Note: bookings.status is VARCHAR, not an enum type, so no ALTER TYPE needed.
-- The payment_pending status is validated at the application layer.

-- Index for free event queries
CREATE INDEX IF NOT EXISTS idx_events_is_free ON events(is_free) WHERE deleted_at IS NULL;

-- Index for payment_pending bookings (cleanup of stale payment pending bookings)
CREATE INDEX IF NOT EXISTS idx_bookings_status_pending_payment
  ON bookings(status) WHERE status = 'payment_pending';

COMMENT ON COLUMN events.is_free IS 'If true, booking bypasses payment and creates confirmed tickets immediately';
