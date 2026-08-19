-- ============================================================================
-- Migration 035: Cinema Screen Layout Versioning
-- ============================================================================
-- Tables: layout_versions, layout_version_seats
--
-- Purpose: Track historical seat layouts for cinemas screens.
--   - A screen can have multiple layouts over time (renovations, reconfigurations).
--   - Bookings and showtimes reference the layout version active at creation time.
--   - One layout version per screen is marked as the current active version.
-- ============================================================================

-- ============================================================================
-- 1. Layout Versions
-- ============================================================================

CREATE TABLE IF NOT EXISTS layout_versions (
  id                SERIAL PRIMARY KEY,
  screen_id         INTEGER NOT NULL REFERENCES cinema_screens(id) ON DELETE CASCADE,
  version_number    INTEGER NOT NULL,
  name              VARCHAR(100),
  description       TEXT,
  seat_capacity     INTEGER NOT NULL,
  row_labels        TEXT[] DEFAULT '{}',
  seats_per_row     INTEGER[] DEFAULT '{}',
  seat_start_number INTEGER DEFAULT 1,
  pricing_rules     JSONB DEFAULT '{}',
  is_active         BOOLEAN NOT NULL DEFAULT false,
  is_current        BOOLEAN NOT NULL DEFAULT false,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (screen_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_layout_versions_screen   ON layout_versions (screen_id);
CREATE INDEX IF NOT EXISTS idx_layout_versions_current  ON layout_versions (screen_id) WHERE is_current = true;

-- ============================================================================
-- 2. Layout Version Seats
-- ============================================================================

CREATE TABLE IF NOT EXISTS layout_version_seats (
  id                SERIAL PRIMARY KEY,
  layout_version_id INTEGER NOT NULL REFERENCES layout_versions(id) ON DELETE CASCADE,
  row_label         VARCHAR(5) NOT NULL,
  seat_number       INTEGER NOT NULL,
  seat_type         VARCHAR(20) NOT NULL DEFAULT 'standard'
                     CHECK (seat_type IN ('standard', 'premium', 'sofa', 'wheelchair')),
  seat_category     VARCHAR(20) NOT NULL DEFAULT 'regular'
                     CHECK (seat_category IN ('regular', 'couple', 'recliner')),
  x_position        NUMERIC(6,2),
  y_position        NUMERIC(6,2),
  is_available      BOOLEAN NOT NULL DEFAULT true,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (layout_version_id, row_label, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_layout_version_seats_layout ON layout_version_seats (layout_version_id);
CREATE INDEX IF NOT EXISTS idx_layout_version_seats_row    ON layout_version_seats (layout_version_id, row_label);

-- ============================================================================
-- 3. Backfill: Create initial layout version for each existing screen
-- ============================================================================

DO $$
DECLARE
  screen_rec RECORD;
  seat_rec RECORD;
  new_version_id INTEGER;
  version_num INTEGER;
BEGIN
  FOR screen_rec IN
    SELECT cs.id, cs.row_labels, cs.seats_per_row, cs.seat_start_number,
           cs.seat_types, cs.pricing_rules, cs.seat_capacity
    FROM cinema_screens cs
    WHERE cs.is_active = true
      AND NOT EXISTS (SELECT 1 FROM layout_versions lv WHERE lv.screen_id = cs.id)
  LOOP
    version_num := COALESCE(
      (SELECT MAX(lv.version_number) FROM layout_versions lv WHERE lv.screen_id = screen_rec.id),
      0
    ) + 1;

    INSERT INTO layout_versions
      (screen_id, version_number, name, seat_capacity, row_labels,
       seats_per_row, seat_start_number, pricing_rules, is_active, is_current)
    VALUES
      (screen_rec.id, version_num, 'Initial Layout', screen_rec.seat_capacity,
       COALESCE(screen_rec.row_labels, ARRAY[]::TEXT[]),
       COALESCE(screen_rec.seats_per_row, ARRAY[]::INTEGER[]),
       screen_rec.seat_start_number, COALESCE(screen_rec.pricing_rules, '{}'::JSONB),
       true, true)
    RETURNING id INTO new_version_id;

    -- Backfill seats from cinema_seats for this screen
    FOR seat_rec IN
      SELECT cs2.row_label, cs2.seat_number, cs2.seat_type, cs2.seat_category,
             cs2.x_position, cs2.y_position, cs2.is_available
      FROM cinema_seats cs2
      WHERE cs2.screen_id = screen_rec.id AND cs2.is_available = true
    LOOP
      INSERT INTO layout_version_seats
        (layout_version_id, row_label, seat_number, seat_type, seat_category,
         x_position, y_position, is_available)
      VALUES
        (new_version_id, seat_rec.row_label, seat_rec.seat_number,
         seat_rec.seat_type, seat_rec.seat_category,
         seat_rec.x_position, seat_rec.y_position, seat_rec.is_available);
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- 4. Showtimes: Add layout version reference (for historical accuracy)
-- ============================================================================

ALTER TABLE IF EXISTS showtimes
  ADD COLUMN IF NOT EXISTS screen_layout_version_id INTEGER REFERENCES layout_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_showtimes_layout_version ON showtimes (screen_layout_version_id);

-- ============================================================================
-- 5. Timestamp trigger for layout_versions
-- ============================================================================

CREATE OR REPLACE FUNCTION update_layout_versions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_layout_versions_timestamp ON layout_versions;
CREATE TRIGGER trg_layout_versions_timestamp
  BEFORE UPDATE ON layout_versions
  FOR EACH ROW EXECUTE FUNCTION update_layout_versions_timestamp();

-- ============================================================================
-- 6. ANALYZE
-- ============================================================================

ANALYZE layout_versions;
ANALYZE layout_version_seats;
