-- ============================================================================
-- Migration 027 — Manager venue/resource assignments
-- ============================================================================
-- Adds assigned_venue_ids to organizer_users so owners can scope managers
-- to specific venues/resources.

ALTER TABLE IF EXISTS organizer_users
  ADD COLUMN IF NOT EXISTS assigned_venue_ids JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN organizer_users.assigned_venue_ids IS 'Array of venue IDs this manager is assigned to. Empty = all venues.';

ANALYZE organizer_users;
