-- ============================================================================
-- Migration 013: Reusable media catalog + per-entity join tables
-- ============================================================================
-- Single canonical media table holding the asset itself, plus typed join
-- tables for each entity that references it. No polymorphic ownership —
-- every join table has a hard FK so referential integrity is enforced.
--
--   media          — the uploaded file (image or video). One row per
--                    unique content hash. Dedupe via sha256_hash UNIQUE.
--   event_media    — event  ↔ media
--
-- Each join table stores:
--   media_type     — role of this asset (poster/banner/gallery/thumbnail/logo)
--   display_order  — ordering within that role
--   status         — active|archived  (unpublish without losing the row)
--   is_primary     — the cover image for the entity
--
-- Video support lives on `media` itself:
--   duration_seconds, video_provider, thumbnail_media_id (self-ref to
--   the video's own poster frame stored in the same table).
--
-- Progressive-loading / theming fields:
--   blur_hash      — LQIP placeholder string
--   dominant_color — #RRGGBB for theming while the image loads
--
-- Fully idempotent. No existing table is modified.
-- ============================================================================

-- ── 1. media : the asset catalog ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS media (
  id                BIGSERIAL PRIMARY KEY,

  -- Ownership
  uploaded_by       BIGINT       DEFAULT NULL,            -- users.id (soft reference)

  -- Storage (provider-agnostic so future S3/CloudFront swap is a single
  -- column change, not a schema change)
  storage_provider  VARCHAR(20)  NOT NULL DEFAULT 'local',
  storage_key       VARCHAR(512) NOT NULL,                -- opaque key, e.g. '2026/08/abc.jpg'

  -- File metadata
  file_name         VARCHAR(255) NOT NULL,
  mime_type         VARCHAR(100) NOT NULL,
  byte_size         BIGINT       NOT NULL CHECK (byte_size >= 0),
  sha256_hash       CHAR(64)     NOT NULL,                -- hex digest; UNIQUE gives us dedup

  -- Image dimensions (NULL for non-images)
  width             INTEGER      DEFAULT NULL CHECK (width IS NULL OR width > 0),
  height            INTEGER      DEFAULT NULL CHECK (height IS NULL OR height > 0),

  -- Video support (NULL for non-videos)
  duration_seconds  INTEGER      DEFAULT NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  video_provider    VARCHAR(30)  DEFAULT NULL,
  thumbnail_media_id BIGINT      DEFAULT NULL,            -- self-ref: video → its poster frame

  -- Resolved URL the API hands back
  public_url        VARCHAR NOT NULL,

  -- Progressive image loading & theming
  blur_hash         VARCHAR(255) DEFAULT NULL,
  dominant_color    VARCHAR(7)   DEFAULT NULL,

  -- Accessibility & visibility
  alt_text          VARCHAR(255) DEFAULT NULL,
  is_public         BOOLEAN      NOT NULL DEFAULT true,

  -- Lifecycle
  deleted_at        TIMESTAMPTZ  DEFAULT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Self-ref: a video can point to its own thumbnail row
  CONSTRAINT fk_media_thumbnail
    FOREIGN KEY (thumbnail_media_id) REFERENCES media(id)
    ON DELETE SET NULL
);

-- Dedupe: same content-hash = same file (only among non-deleted rows)
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha256_unique
  ON media (sha256_hash)
  WHERE deleted_at IS NULL;

-- Common lookups
CREATE INDEX IF NOT EXISTS idx_media_storage
  ON media (storage_provider, storage_key);

CREATE INDEX IF NOT EXISTS idx_media_uploaded_by
  ON media (uploaded_by)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_mime_type
  ON media (mime_type)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_created_at
  ON media (created_at DESC)
  WHERE deleted_at IS NULL;

-- Storage provider constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_storage_provider_check'
  ) THEN
    ALTER TABLE media
      ADD CONSTRAINT media_storage_provider_check
      CHECK (storage_provider IN ('local', 's3', 'cdn', 'gcs'));
  END IF;
END $$;

-- Upper-bound: 2 GB per file
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_byte_size_check'
  ) THEN
    ALTER TABLE media
      ADD CONSTRAINT media_byte_size_check
      CHECK (byte_size <= 2147483648);
  END IF;
END $$;

-- Video provider constraint (nullable; only enforced when set)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_video_provider_check'
  ) THEN
    ALTER TABLE media
      ADD CONSTRAINT media_video_provider_check
      CHECK (
        video_provider IS NULL
        OR video_provider IN ('local','youtube','vimeo','mux','cloudflare')
      );
  END IF;
END $$;

-- Dominant color must be a hex #RRGGBB if present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_dominant_color_check'
  ) THEN
    ALTER TABLE media
      ADD CONSTRAINT media_dominant_color_check
      CHECK (
        dominant_color IS NULL
        OR dominant_color ~ '^#[0-9a-fA-F]{6}$'
      );
  END IF;
END $$;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION media_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_media_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_media_set_updated_at
      BEFORE UPDATE ON media
      FOR EACH ROW
      EXECUTE FUNCTION media_set_updated_at();
  END IF;
END $$;


-- ── 2. event_media : event ↔ media ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_media (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT  NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  media_id      BIGINT  NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  media_type    VARCHAR(20) NOT NULL DEFAULT 'gallery',
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  deleted_at    TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_event_media_event_media UNIQUE (event_id, media_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_media_media_type_check'
  ) THEN
    ALTER TABLE event_media
      ADD CONSTRAINT event_media_media_type_check
      CHECK (media_type IN ('poster','banner','gallery','thumbnail','logo'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_media_status_check'
  ) THEN
    ALTER TABLE event_media
      ADD CONSTRAINT event_media_status_check
      CHECK (status IN ('active','archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_media_event
  ON event_media (event_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_event_media_ordering
  ON event_media (event_id, media_type, display_order)
  WHERE deleted_at IS NULL;

-- Partial unique: at most one "primary" asset per (event, media_type)
-- Means we can have one primary poster AND one primary thumbnail, but
-- not two primary posters.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_event_media_primary_per_role'
  ) THEN
    CREATE UNIQUE INDEX uniq_event_media_primary_per_role
      ON event_media (event_id, media_type)
      WHERE is_primary = true AND deleted_at IS NULL;
  END IF;
END $$;


-- ── 6. ANALYZE for the planner ───────────────────────────────────────────────
ANALYZE media;
ANALYZE event_media;
