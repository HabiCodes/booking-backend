-- ============================================================================
-- Migration 006: Admin RBAC + audit log
-- Adds admin role enum, an audit_log table for admin actions
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admins' AND column_name = 'role') THEN
    ALTER TABLE admins ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'admin';
    ALTER TABLE admins ADD CONSTRAINT admins_role_check
      CHECK (role IN ('super_admin', 'admin', 'moderator', 'viewer'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admins' AND column_name = 'is_active') THEN
    ALTER TABLE admins ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'admins' AND column_name = 'last_login_at') THEN
    ALTER TABLE admins ADD COLUMN last_login_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Audit log for all admin actions (uploads, deletes, restores, etc.)
CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  admin_id      BIGINT DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  action        VARCHAR(80) NOT NULL,
  entity_type   VARCHAR(50) DEFAULT NULL,
  entity_id     BIGINT DEFAULT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address    VARCHAR(45) DEFAULT NULL,
  user_agent    TEXT DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_time ON audit_logs(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);