-- Account lockout protection for admin login
-- Adds failed_login_attempts and locked_until to admins table
-- Creates login_attempts table for rate limiting and audit

-- Add columns to admins table
ALTER TABLE admins ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ DEFAULT NULL;

-- Create index for checking locked accounts efficiently
CREATE INDEX IF NOT EXISTS idx_admins_locked_until ON admins(locked_until) WHERE locked_until IS NOT NULL;

-- Login attempts table for brute-force tracking
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES admins(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  user_agent TEXT,
  success BOOLEAN NOT NULL DEFAULT false,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_email ON admin_login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_admin ON admin_login_attempts(admin_id, attempted_at);
CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip ON admin_login_attempts(ip_address, attempted_at);

-- Auto-cleanup old attempts (older than 24 hours)
-- This can be run periodically via a cron job or worker
