-- ============================================================================
-- Migration 044: Add organization_id to admins for scanner authorization
-- ============================================================================
--
-- Adds organization_id (nullable) to the admins table to enable
-- org-scoped scanner access control.
--
-- Organization scoping rules:
--   organization_id IS NULL  → Super-admin: can scan tickets for any organization
--   organization_id = <id>   → Restricted to that organization only
--
-- The scan middleware validates that the authenticated admin's organization_id
-- matches the ticket's organization, unless the admin is a super-admin (NULL).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admins' AND column_name = 'organization_id'
  ) THEN
    ALTER TABLE admins
      ADD COLUMN organization_id BIGINT DEFAULT NULL
      REFERENCES organizations(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_admins_organization
      ON admins (organization_id)
      WHERE organization_id IS NOT NULL;

    COMMENT ON COLUMN admins.organization_id IS
      'Organization restriction for scanner access. NULL = super-admin (all orgs). Non-NULL = restricted to that organization only.';
  END IF;
END $$;

ANALYZE admins;
