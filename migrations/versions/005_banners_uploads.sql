-- ============================================================================
-- Migration 005: Dynamic Advertisement Banner
-- Only one banner is active at a time. New uploads deactivate old ones
-- inside a transaction. No code changes required when banner is replaced.
-- ============================================================================

CREATE TABLE IF NOT EXISTS advertisement_banners (
  id            BIGSERIAL PRIMARY KEY,
  image_url     VARCHAR(512) NOT NULL,
  cloudinary_public_id VARCHAR(255) DEFAULT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT false,
  uploaded_by   BIGINT DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  activated_at  TIMESTAMPTZ DEFAULT NULL,
  deactivated_at TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A partial unique index ensures at most one active banner at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_banner_unique_active
  ON advertisement_banners(is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_ad_banner_active_created
  ON advertisement_banners(created_at DESC)
  WHERE is_active = true;

-- File uploads metadata (for tracking and security)
CREATE TABLE IF NOT EXISTS file_uploads (
  id            BIGSERIAL PRIMARY KEY,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL UNIQUE,
  mime_type     VARCHAR(120) NOT NULL,
  size_bytes    BIGINT NOT NULL,
  entity_type   VARCHAR(50) DEFAULT NULL,
  entity_id     BIGINT DEFAULT NULL,
  uploaded_by   BIGINT DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_entity ON file_uploads(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_file_uploads_created ON file_uploads(created_at DESC);