-- ============================================================================
-- Migration 011: Events — pricing, organizer, published_at
--
-- Adds columns to the `events` table that are referenced by
-- src/repositories/eventRepository.ts and src/types/index.ts but were never
-- migrated into the schema:
--
--   price        NUMERIC(10,2)  NOT NULL DEFAULT 0
--   currency     VARCHAR(3)     NOT NULL DEFAULT 'INR'
--   organizer    VARCHAR(255)   DEFAULT NULL
--   published_at TIMESTAMPTZ    DEFAULT NULL
--
-- Root cause of the runtime error:
--   "PostgreSQL ERROR 42703: column 'price' does not exist"
--
-- This migration is fully idempotent and production-safe:
--  - Each ALTER TABLE is guarded with IF NOT EXISTS.
--  - Existing rows get the column defaults (no data loss).
--  - CHECK constraints are idempotent.
--  - CREATE INDEX IF NOT EXISTS for the new indexes.
-- ============================================================================

-- ── Columns ───────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'price'
  ) THEN
    ALTER TABLE events ADD COLUMN price NUMERIC(10,2) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'currency'
  ) THEN
    ALTER TABLE events ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'INR';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'organizer'
  ) THEN
    ALTER TABLE events ADD COLUMN organizer VARCHAR(255) DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'published_at'
  ) THEN
    ALTER TABLE events ADD COLUMN published_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- ── Constraints ───────────────────────────────────────────────────────────────

-- Ensure price is never negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_price_nonneg'
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_price_nonneg CHECK (price >= 0);
  END IF;
END $$;

-- Ensure currency is a 3-letter ISO-4217 code (e.g., INR, USD, EUR).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_currency_iso'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_currency_iso CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Currency-filtered lookups on active published events.
CREATE INDEX IF NOT EXISTS idx_events_currency
  ON events(currency)
  WHERE deleted_at IS NULL AND status = 'published';

-- ── ANALYZE ───────────────────────────────────────────────────────────────────
-- Refresh planner stats so subsequent queries pick up the new columns/indexes.
ANALYZE events;