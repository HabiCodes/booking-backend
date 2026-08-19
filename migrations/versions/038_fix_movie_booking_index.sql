-- ============================================================================
-- Migration 038: Fix movie seat double-booking protection
-- ============================================================================
-- Migration 033 created an invalid partial unique index on movie_booking_items
-- using a subquery in the WHERE clause. PostgreSQL does not allow subqueries
-- in partial index predicates. The index was never created, meaning the DB
-- had no guard against seat double-booking (application-layer locking via
-- FOR UPDATE on showtime was the only protection).
--
-- This migration:
--   1. Adds a denormalized booking_status column to movie_booking_items
--   2. Creates a trigger to keep it in sync with movie_bookings.status
--   3. Backfills existing booking_items from current booking statuses
--   4. Drops the invalid index (safe no-op since it never existed)
--   5. Creates a valid partial unique index on (seat_id, showtime_id)
--      WHERE booking_status IN ('pending_payment', 'confirmed')
-- ============================================================================


-- 1. Add booking_status column to movie_booking_items
ALTER TABLE movie_booking_items
  ADD COLUMN IF NOT EXISTS booking_status VARCHAR(20) NOT NULL DEFAULT 'pending_payment';


-- 2. Create trigger functions to sync booking_status from movie_bookings
--
--    sync_on_insert: When a booking is created, set booking_status on all
--    its items (handles bookings created directly with 'confirmed' status,
--    e.g., offline bookings).
--    sync_on_update: When a booking's status changes, propagate the new
--    status to all its items (pending_payment → confirmed / cancelled / expired).

CREATE OR REPLACE FUNCTION sync_movie_booking_item_status_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE movie_booking_items
    SET booking_status = NEW.status
    WHERE booking_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sync_movie_booking_item_status_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE movie_booking_items
      SET booking_status = NEW.status
      WHERE booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- 3. Create triggers on movie_bookings
DROP TRIGGER IF EXISTS trg_sync_booking_status_insert ON movie_bookings;
DROP TRIGGER IF EXISTS trg_sync_booking_status_update ON movie_bookings;

CREATE TRIGGER trg_sync_booking_status_insert
  AFTER INSERT ON movie_bookings
  FOR EACH ROW EXECUTE FUNCTION sync_movie_booking_item_status_on_insert();

CREATE TRIGGER trg_sync_booking_status_update
  BEFORE UPDATE OF status ON movie_bookings
  FOR EACH ROW EXECUTE FUNCTION sync_movie_booking_item_status_on_update();


-- 4. Backfill existing booking_items from current booking statuses
UPDATE movie_booking_items mbi
  SET booking_status = mb.status
  FROM movie_bookings mb
  WHERE mbi.booking_id = mb.id;


-- 5. Drop the invalid index (safe: it was never created)
DROP INDEX IF EXISTS idx_movie_booking_items_seat_showtime_active;


-- 6. Create valid partial unique index using the denormalized column
CREATE UNIQUE INDEX IF NOT EXISTS idx_movie_booking_items_seat_showtime_active
  ON movie_booking_items (seat_id, showtime_id)
  WHERE booking_status IN ('pending_payment', 'confirmed');
