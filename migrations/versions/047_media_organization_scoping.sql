-- ============================================================================
-- Migration 047: Media organization scoping + S3 lifecycle
-- ============================================================================
--
-- 1. Add organization_id to media for proxy auth (cross-org access control)
-- 2. Add uploaded_by_role to distinguish admin/organizer/system uploaders
-- 3. Add organization_id index for proxy lookups
--
-- The media proxy uses these fields for authorization:
--   - organization_id: required for private media access control
--   - uploaded_by_role: logged for audit trail

DO $$
BEGIN
  -- organization_id on media
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'media' AND column_name = 'organization_id'
  ) THEN
    ALTER TABLE media
      ADD COLUMN organization_id BIGINT DEFAULT NULL
      REFERENCES organizations(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_media_organization
      ON media (organization_id)
      WHERE organization_id IS NOT NULL;
  END IF;

  -- uploaded_by_role on media
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'media' AND column_name = 'uploaded_by_role'
  ) THEN
    ALTER TABLE media
      ADD COLUMN uploaded_by_role VARCHAR(20) DEFAULT NULL
      CHECK (uploaded_by_role IS NULL OR uploaded_by_role IN ('admin', 'organizer', 'system', 'customer'));

    CREATE INDEX IF NOT EXISTS idx_media_uploaded_by_role
      ON media (uploaded_by_role)
      WHERE uploaded_by_role IS NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN media.organization_id IS
  'Organization that owns this media. NULL = global (uploaded by super-admin or system). Used for proxy auth.';
COMMENT ON COLUMN media.uploaded_by_role IS
  'Role of the user who uploaded this media: admin, organizer, system, or customer.';

ANALYZE media;
