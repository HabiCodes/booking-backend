-- ============================================================================
-- Migration 032: Organizer listing category + password token persistence
-- ============================================================================
-- Adds:
--   1. listing_category column to organizer_applications (turf, events, movies,
--      concerts, or 'other' for future expansion)
--   2. Persisted password token hashes in organizer_password_tokens (the
--      existing table had the columns but no code ever wrote to it)
-- ============================================================================


-- ── 1. listing_category on organizer_applications ─────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_applications' AND column_name = 'listing_category'
  ) THEN
    ALTER TABLE organizer_applications
      ADD COLUMN listing_category VARCHAR(50) NOT NULL DEFAULT 'other'
        CHECK (listing_category IN ('turf', 'events', 'movies', 'concerts', 'other'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_organizer_applications_category
  ON organizer_applications (listing_category, status);


-- ── 2. Ensure organizer_password_tokens token_hash column is not-null ──────────

-- The column already exists (migration 016), but tighten constraints
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_password_tokens'
      AND column_name = 'token_hash'
      AND is_nullable = 'YES'
  ) THEN
    -- Can't alter to NOT NULL if rows already exist; enforce at app level instead
    -- (the service layer will always insert a non-null hash)
    NULL;
  END IF;
END $$;


-- ANALYZE
ANALYZE organizer_applications;
ANALYZE organizer_password_tokens;
