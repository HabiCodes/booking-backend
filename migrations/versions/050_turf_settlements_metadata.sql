-- ============================================================================
-- Migration 050: Add metadata column to turf_settlements for domain disambiguation
-- ============================================================================
--
-- Movie settlements share the turf_settlements table with turf.
-- This migration adds a metadata JSONB column so movie settlement rows
-- can be identified via metadata->>'domain' = 'movie'.
--
-- Backfill strategy:
--   All existing rows are tagged as 'turf' because the movie domain
--   was added after the original turf_settlements infrastructure.
--   Any new settlement created by the movieSettlementRepository will
--   be tagged with domain:'movie', and turf settlements with domain:'turf'.

-- Add metadata column
ALTER TABLE turf_settlements
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Backfill: all existing rows (created before this migration) are turf settlements
UPDATE turf_settlements
  SET metadata = '{"domain":"turf"}'::jsonb
  WHERE metadata IS NULL OR metadata = '{}'::jsonb;

-- Index for movie domain lookups (used by dashboard settlement history query)
CREATE INDEX IF NOT EXISTS idx_turf_settlements_metadata_domain
  ON turf_settlements ((metadata->>'domain'))
  WHERE metadata IS NOT NULL AND metadata <> '{}'::jsonb;

-- Comments
COMMENT ON COLUMN turf_settlements.metadata IS
  'Domain disambiguation for shared turf/movie settlement table: {"domain":"turf"} or {"domain":"movie"}';
