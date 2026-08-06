-- ============================================================================
-- Migration 002: Events table expansion
-- Adds: subtitle, category, address, city, state, country, lat/lng,
--       start_time/end_time, thumbnail, gallery (jsonb),
--       remaining_capacity, status, visibility, is_featured,
--       updated_at, deleted_at (soft delete)
-- Backward-compat: Leaves existing rows intact, fills defaults.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'subtitle') THEN
    ALTER TABLE events ADD COLUMN subtitle VARCHAR(255) DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'category') THEN
    ALTER TABLE events ADD COLUMN category VARCHAR(80) DEFAULT 'general';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'address') THEN
    ALTER TABLE events ADD COLUMN address TEXT DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'city') THEN
    ALTER TABLE events ADD COLUMN city VARCHAR(120) DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'state') THEN
    ALTER TABLE events ADD COLUMN state VARCHAR(120) DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'country') THEN
    ALTER TABLE events ADD COLUMN country VARCHAR(120) DEFAULT 'India';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'latitude') THEN
    ALTER TABLE events ADD COLUMN latitude DOUBLE PRECISION DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'longitude') THEN
    ALTER TABLE events ADD COLUMN longitude DOUBLE PRECISION DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'event_date') THEN
    ALTER TABLE events ADD COLUMN event_date DATE DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'start_time') THEN
    ALTER TABLE events ADD COLUMN start_time TIME DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'end_time') THEN
    ALTER TABLE events ADD COLUMN end_time TIME DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'thumbnail_url') THEN
    ALTER TABLE events ADD COLUMN thumbnail_url VARCHAR(512) DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'gallery') THEN
    ALTER TABLE events ADD COLUMN gallery JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'remaining_capacity') THEN
    ALTER TABLE events ADD COLUMN remaining_capacity INTEGER DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'status') THEN
    ALTER TABLE events ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'published';
    ALTER TABLE events ADD CONSTRAINT events_status_check
      CHECK (status IN ('draft', 'published', 'hidden', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'visibility') THEN
    ALTER TABLE events ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public';
    ALTER TABLE events ADD CONSTRAINT events_visibility_check
      CHECK (visibility IN ('public', 'private', 'unlisted'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'is_featured') THEN
    ALTER TABLE events ADD COLUMN is_featured BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'is_active') THEN
    ALTER TABLE events ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'updated_at') THEN
    ALTER TABLE events ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'deleted_at') THEN
    ALTER TABLE events ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

UPDATE events
SET event_date = DATE(start_at),
    start_time = (start_at AT TIME ZONE 'UTC')::time,
    end_time   = (end_at AT TIME ZONE 'UTC')::time
WHERE event_date IS NULL OR start_time IS NULL;

-- Indexes for production-grade query patterns
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_status') THEN
    CREATE INDEX idx_events_status ON events(status) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_category') THEN
    CREATE INDEX idx_events_category ON events(category) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_event_date') THEN
    CREATE INDEX idx_events_event_date ON events(event_date) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_is_featured') THEN
    CREATE INDEX idx_events_is_featured ON events(is_featured) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_city') THEN
    CREATE INDEX idx_events_city ON events(city) WHERE deleted_at IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_published_at') THEN
    CREATE INDEX idx_events_published_at ON events(created_at DESC) WHERE status = 'published' AND deleted_at IS NULL;
  END IF;
END $$;
