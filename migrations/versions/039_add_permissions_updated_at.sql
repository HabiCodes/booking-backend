-- Add permissions_updated_at column to admins table
-- Tracks when an admin's role or granular permissions were last modified,
-- enabling the auth middleware to force re-authentication when permissions change.

ALTER TABLE admins ADD COLUMN IF NOT EXISTS permissions_updated_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill existing admins: use created_at so their existing JWTs remain valid
UPDATE admins SET permissions_updated_at = created_at WHERE permissions_updated_at IS NULL;

-- Index for the freshness-check query in adminAuth.ts
CREATE INDEX IF NOT EXISTS idx_admins_permissions_updated_at ON admins(permissions_updated_at);
