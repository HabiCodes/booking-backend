-- ============================================================================
-- Migration 019: Organizer event lifecycle + rejection details
-- ============================================================================
-- Extends the organizer event workflow with rejection tracking, review info,
-- and an append-only organizer_event_history audit table.

-- ── 1. Extend events with rejection + review fields ───────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'reviewed_by'
  ) THEN
    ALTER TABLE events ADD COLUMN reviewed_by BIGINT DEFAULT NULL
      REFERENCES admins(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'rejection_reason'
  ) THEN
    ALTER TABLE events ADD COLUMN rejection_reason TEXT DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'reviewed_at'
  ) THEN
    ALTER TABLE events ADD COLUMN reviewed_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'submitted_at'
  ) THEN
    ALTER TABLE events ADD COLUMN submitted_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

-- Index for admin review queue
CREATE INDEX IF NOT EXISTS idx_events_organizer_review
  ON events (organization_id, organizer_status, submitted_at)
  WHERE organization_id IS NOT NULL
    AND organizer_status IN ('submitted', 'approved', 'rejected', 'draft');

-- ── 2. organizer_event_history: append-only audit trail ──────────────────────

CREATE TABLE IF NOT EXISTS organizer_event_history (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Who made the change
  actor_type      VARCHAR(20) NOT NULL DEFAULT 'organizer_user'
    CHECK (actor_type IN ('organizer_user', 'admin', 'system')),
  actor_user_id   BIGINT DEFAULT NULL REFERENCES organizer_users(id) ON DELETE SET NULL,
  actor_admin_id  BIGINT DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,

  -- Transition
  from_status     VARCHAR(20) DEFAULT NULL,
  to_status       VARCHAR(20) NOT NULL,

  -- Optional context
  reason          TEXT         DEFAULT NULL,
  metadata        JSONB        DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizer_event_hist_event
  ON organizer_event_history (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_event_hist_org
  ON organizer_event_history (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_organizer_event_hist_actor
  ON organizer_event_history (actor_admin_id)
  WHERE actor_admin_id IS NOT NULL;

-- ANALYZE
ANALYZE events;
ANALYZE organizer_event_history;
