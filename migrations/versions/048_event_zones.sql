-- ============================================================================
-- Migration 048: Event Zones (Layout-Based Paid Events)
-- ============================================================================
-- Supports layout-based paid events where zones have different capacities
-- and prices. Booking is still quantity-based (NOT seat-based) — users select
-- a zone and specify how many tickets they want from that zone's remaining
-- capacity.
--
-- Architecture:
--   event_zones table — per-zone config linked to an event
--   zone_capacity is tracked in the zone row itself (separate from events.remaining_capacity)
--
-- Booking flow for layout-based events:
--   1. User selects zone_id + quantity
--   2. Backend checks zone_capacity >= quantity
--   3. Atomically decrement zone_capacity
--   4. Also decrement events.remaining_capacity (global cap)
--   5. Create booking with zone_id stored in metadata
--
-- ============================================================================

-- ── 1. event_zones table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_zones (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Zone identification
  name            VARCHAR(100) NOT NULL,           -- e.g. "VIP", "General", "Balcony"
  description     TEXT DEFAULT NULL,
  color           VARCHAR(7) DEFAULT NULL,         -- hex color for UI display

  -- Capacity
  total_capacity  INTEGER NOT NULL DEFAULT 0,
  remaining_capacity INTEGER NOT NULL DEFAULT 0,

  -- Pricing
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(3) NOT NULL DEFAULT 'INR',

  -- Display order
  sort_order      INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle
  is_active       BOOLEAN NOT NULL DEFAULT true,
  deleted_at      TIMESTAMPTZ DEFAULT NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_event_zone_name UNIQUE (event_id, name) WHERE deleted_at IS NULL
);

CREATE INDEX IF NOT EXISTS idx_event_zones_event
  ON event_zones (event_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_zones_event_active
  ON event_zones (event_id, is_active) WHERE deleted_at IS NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION event_zones_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_event_zones_updated_at'
  ) THEN
    CREATE TRIGGER trg_event_zones_updated_at
      BEFORE UPDATE ON event_zones
      FOR EACH ROW
      EXECUTE FUNCTION event_zones_set_updated_at();
  END IF;
END $$;

-- ── 2. booking_zones join table ────────────────────────────────────────────────
-- Records which zone(s) a booking consumed tickets from.
-- For quantity-based bookings, each booking maps to exactly one zone.
-- For future seat-based extensions, a booking could map to multiple zones.

CREATE TABLE IF NOT EXISTS booking_zones (
  id              BIGSERIAL PRIMARY KEY,
  booking_id      BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  zone_id         BIGINT NOT NULL REFERENCES event_zones(id) ON DELETE RESTRICT,
  ticket_count    INTEGER NOT NULL DEFAULT 0,
  unit_price_paise INTEGER NOT NULL DEFAULT 0,     -- price at time of booking
  subtotal_paise  INTEGER NOT NULL DEFAULT 0,      -- unit_price * ticket_count

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_booking_zone UNIQUE (booking_id, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_zones_booking
  ON booking_zones (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_zones_zone
  ON booking_zones (zone_id);

-- ── 3. CHECK constraint on event_zones ────────────────────────────────────────

ALTER TABLE event_zones
  ADD CONSTRAINT event_zones_price_nonneg
  CHECK (price >= 0);

ALTER TABLE event_zones
  ADD CONSTRAINT event_zones_total_capacity_positive
  CHECK (total_capacity >= 0);

ALTER TABLE event_zones
  ADD CONSTRAINT event_zones_remaining_nonneg
  CHECK (remaining_capacity >= 0);

-- ── 4. ANALYZE ──────────────────────────────────────────────────────────────────

ANALYZE event_zones;
ANALYZE booking_zones;
