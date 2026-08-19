-- ============================================================================
-- Migration 037: Movie offline/counter booking + UPI/Card/Cash payment
-- ============================================================================
-- Adds offline booking support for the movie domain, mirroring the turf
-- domain's booking_type pattern. Enables cinema box-office staff to book
-- seats at the counter and record UPI / Card / Cash payments directly.
-- ============================================================================

-- 1. Add booking_type and offline tracking to movie_bookings
-- booking_type mirrors turf_bookings.booking_type:
--   'online'    → customer booked via app/website (default)
--   'offline'   → box-office staff booked at counter
--   'complimentary' → complimentary passes / reviewer / VIP

ALTER TABLE movie_bookings
  ADD COLUMN IF NOT EXISTS booking_type VARCHAR(20) NOT NULL DEFAULT 'online'
    CHECK (booking_type IN ('online', 'offline', 'complimentary'));

ALTER TABLE movie_bookings
  ADD COLUMN IF NOT EXISTS offline_by_user_id INTEGER
    REFERENCES organizer_users(id) ON DELETE SET NULL;

ALTER TABLE movie_bookings
  ADD COLUMN IF NOT EXISTS customer_email VARCHAR(255);
ALTER TABLE movie_bookings
  ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20);
ALTER TABLE movie_bookings
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255);

-- 2. Update CHECK constraint on payment_status to include 'paid_offline'
-- Drop and recreate the constraint
ALTER TABLE movie_bookings
  DROP CONSTRAINT IF EXISTS movie_bookings_payment_status_check;

ALTER TABLE movie_bookings
  ADD CONSTRAINT movie_bookings_payment_status_check
    CHECK (payment_status IN ('initiated', 'pending', 'captured', 'failed', 'refunded', 'paid_offline'));

-- 3. Index for offline booking lookups by staff member
CREATE INDEX IF NOT EXISTS idx_movie_bookings_offline_by_user
  ON movie_bookings (offline_by_user_id)
  WHERE booking_type = 'offline' AND deleted_at IS NULL;

-- 4. Index for offline booking lookups by organization
CREATE INDEX IF NOT EXISTS idx_movie_bookings_offline_org
  ON movie_bookings (organization_id, booking_type, created_at DESC)
  WHERE booking_type = 'offline' AND deleted_at IS NULL;

-- 5. Extend payment_gateway type in payment_orders to include 'manual'
-- For offline bookings, the gateway is recorded as 'manual' and the
-- payment_method column holds 'CASH' | 'UPI' | 'CARD'.

-- Update the CHECK on booking_type in payment_orders to include 'movie_offline'
-- (already includes 'movie' from migration 034 — keep as is for gateway type)

-- The payment_orders.payment_method column already exists as VARCHAR(40).
-- We just need to document the allowed values:
--   For online: Cashfree reports 'UPI', 'CARD', 'NETBANKING', 'WALLET'
--   For offline: backend records 'CASH', 'UPI', 'CARD'

-- 6. Trigger: set booking_type automatically from offline_by_user_id
CREATE OR REPLACE FUNCTION set_movie_booking_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.offline_by_user_id IS NOT NULL AND NEW.booking_type = 'online' THEN
    NEW.booking_type := 'offline';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movie_bookings_set_type ON movie_bookings;
CREATE TRIGGER trg_movie_bookings_set_type
  BEFORE INSERT ON movie_bookings
  FOR EACH ROW EXECUTE FUNCTION set_movie_booking_type();

-- ANALYZE
ANALYZE movie_bookings;
