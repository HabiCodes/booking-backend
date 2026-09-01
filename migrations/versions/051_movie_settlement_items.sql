-- Migration 051: Create movie_settlement_items table for proper FK to movie_bookings
--
-- BACKGROUND:
-- The movie domain shares turf_settlements (header) with turf, but
-- turf_settlement_items.booking_id has a FK to turf_bookings(id).
-- Movie settlement items use movie_bookings.id, which is a separate
-- SERIAL sequence, so the FK rejects every insert.
--
-- This migration creates a dedicated movie_settlement_items table with
-- the correct FK to movie_bookings(id).

-- ── Create movie_settlement_items ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS movie_settlement_items (
    id                  SERIAL PRIMARY KEY,
    settlement_id       INT NOT NULL REFERENCES turf_settlements(id) ON DELETE CASCADE,
    booking_id          INT NOT NULL REFERENCES movie_bookings(id) ON DELETE CASCADE,
    gross_amount        NUMERIC(10,2) NOT NULL,
    commission_amount   NUMERIC(10,2) NOT NULL,
    tax_amount          NUMERIC(10,2) NOT NULL,
    net_amount          NUMERIC(10,2) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movie_settlement_items_settlement
    ON movie_settlement_items(settlement_id);

CREATE INDEX IF NOT EXISTS idx_movie_settlement_items_booking
    ON movie_settlement_items(booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_settlement_item_booking_id
    ON movie_settlement_items(booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_settlement_item_settlement_booking
    ON movie_settlement_items(settlement_id, booking_id);

COMMENT ON TABLE movie_settlement_items IS
    'Settlement item details for movie bookings. booking_id references movie_bookings(id).';
