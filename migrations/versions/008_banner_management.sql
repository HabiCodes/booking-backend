-- ============================================================================
-- Migration 008: Banner management upgrade + file upload extensions
--
-- Extends the existing `advertisement_banners` and `file_uploads` tables
-- created in migration 005. Adds placement, dimensions, deletion, and the
-- "one active ticket_advertisement at a time" guarantee.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- advertisement_banners extensions
-- ----------------------------------------------------------------------------

-- placement: which part of the app this banner belongs to
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'advertisement_banners' AND column_name = 'placement'
  ) THEN
    ALTER TABLE advertisement_banners
      ADD COLUMN placement VARCHAR(50) NOT NULL DEFAULT 'ticket_advertisement',
      ADD CONSTRAINT banner_placement_check
        CHECK (placement IN ('ticket_advertisement', 'homepage_hero', 'event_thumbnail'));
  END IF;
END $$;

-- Image dimensions (stored for responsive rendering)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'advertisement_banners' AND column_name = 'width'
  ) THEN
    ALTER TABLE advertisement_banners
      ADD COLUMN width INTEGER DEFAULT NULL,
      ADD COLUMN height INTEGER DEFAULT NULL;
  END IF;
END $$;

-- File metadata
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'advertisement_banners' AND column_name = 'file_size_bytes'
  ) THEN
    ALTER TABLE advertisement_banners
      ADD COLUMN file_size_bytes BIGINT DEFAULT NULL,
      ADD COLUMN mime_type VARCHAR(120) DEFAULT NULL;
  END IF;
END $$;

-- Display metadata
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'advertisement_banners' AND column_name = 'alt_text'
  ) THEN
    ALTER TABLE advertisement_banners
      ADD COLUMN alt_text VARCHAR(255) DEFAULT NULL,
      ADD COLUMN link_url VARCHAR(512) DEFAULT NULL,
      ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

-- Soft delete
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'advertisement_banners' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE advertisement_banners
      ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Backfill existing rows to ticket_advertisement
UPDATE advertisement_banners
   SET placement = 'ticket_advertisement'
 WHERE placement IS NULL OR placement = '';

-- ----------------------------------------------------------------------------
-- Replace the old "one active across all placements" index with a
-- placement-scoped partial unique index. Only one ticket_advertisement
-- banner may be active at a time; homepage_hero banners have no limit.
-- ----------------------------------------------------------------------------

-- Drop the old index if it exists
DROP INDEX IF EXISTS idx_ad_banner_unique_active;

-- New partial unique index: only ticket_advertisement banners
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_banner_active_unique_placement
  ON advertisement_banners(placement)
  WHERE is_active = true
    AND deleted_at IS NULL
    AND placement = 'ticket_advertisement';

-- Keep the lookup index, but filter out deleted
DROP INDEX IF EXISTS idx_ad_banner_active_created;
CREATE INDEX IF NOT EXISTS idx_ad_banner_active_created
  ON advertisement_banners(placement, created_at DESC)
  WHERE is_active = true AND deleted_at IS NULL;

-- General index for admin listing
CREATE INDEX IF NOT EXISTS idx_ad_banner_placement_deleted
  ON advertisement_banners(placement, deleted_at, created_at DESC);

-- ----------------------------------------------------------------------------
-- file_uploads extensions
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'file_uploads' AND column_name = 'width'
  ) THEN
    ALTER TABLE file_uploads
      ADD COLUMN width INTEGER DEFAULT NULL,
      ADD COLUMN height INTEGER DEFAULT NULL,
      ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Soft-delete index
CREATE INDEX IF NOT EXISTS idx_file_uploads_not_deleted
  ON file_uploads(created_at DESC)
  WHERE deleted_at IS NULL;
