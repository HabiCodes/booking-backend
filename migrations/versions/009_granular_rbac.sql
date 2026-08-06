-- ============================================================================
-- Migration 009: Granular RBAC
-- - Adds `permissions` JSONB to admins (per-admin override map)
-- - Extends role enum to support 4-tier model: super_admin, admin, event_manager, ticket_scanner
-- - Backfills legacy roles: moderator → event_manager, viewer → ticket_scanner
-- ============================================================================

-- ── 1. Migrate legacy role values BEFORE changing the constraint
UPDATE admins SET role = 'event_manager' WHERE role = 'moderator';
UPDATE admins SET role = 'ticket_scanner' WHERE role = 'viewer';

-- ── 2. Drop old role check constraint if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'admins' AND constraint_name = 'admins_role_check'
  ) THEN
    ALTER TABLE admins DROP CONSTRAINT admins_role_check;
  END IF;
END $$;

-- ── 3. Re-create constraint with 4 new role values
ALTER TABLE admins ADD CONSTRAINT admins_role_check
  CHECK (role IN ('super_admin', 'admin', 'event_manager', 'ticket_scanner'));

-- ── 4. Add permissions JSONB column (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admins' AND column_name = 'permissions'
  ) THEN
    ALTER TABLE admins ADD COLUMN permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- ── 5. Index for active admins by role (super-admin-style queries)
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role) WHERE is_active = true;
