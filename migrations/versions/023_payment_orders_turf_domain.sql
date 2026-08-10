-- ============================================================================
-- Migration 023: Relax event_id NOT NULL for Turf domain support
-- ============================================================================

-- The payment_orders table was created with event_id NOT NULL (FK to events).
-- Turf bookings have no event_id, so we make it nullable and add a
-- booking_type discriminator so queries can filter by domain.

DO $$
BEGIN
  -- Drop the NOT NULL constraint on event_id
  ALTER TABLE payment_orders ALTER COLUMN event_id DROP NOT NULL;

  -- Drop the FK constraint (can't reference events when value is NULL for Turf)
  ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_event_id_fkey;

  -- Add booking_type discriminator: 'event' | 'turf'
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_orders' AND column_name = 'booking_type'
  ) THEN
    ALTER TABLE payment_orders ADD COLUMN booking_type VARCHAR(20) NOT NULL DEFAULT 'event'
      CHECK (booking_type IN ('event', 'turf'));
  END IF;

  -- Update the event_id index to be partial (only for event-type payments)
  DROP INDEX IF EXISTS idx_payment_orders_event;
  CREATE INDEX IF NOT EXISTS idx_payment_orders_event
    ON payment_orders (event_id)
    WHERE event_id IS NOT NULL;

  -- Index for Turf bookings
  CREATE INDEX IF NOT EXISTS idx_payment_orders_booking_type
    ON payment_orders (booking_type, booking_id);
END $$;

ANALYZE payment_orders;
