-- ============================================================================
-- Migration 014: Event lifecycle (Draft → Pending Review → Approved →
--                Published → Hidden → Archived)
-- ============================================================================
-- Adds two capabilities to the existing `events` table:
--
--   1. Three new status values:
--        pending_review  — submitted for approval
--        approved        — approved but not yet published
--        archived        — soft-archived (different from soft-deleted)
--
--   2. An append-only audit trail of every status change:
--        event_status_history
--
-- Plus two workflow columns:
--
--   submitted_for_review_at  — set when status moves to pending_review
--   approved_at              — set when status moves to approved
--   approved_by              — admin who approved (FK to admins.id)
--   archived_at              — set when status moves to archived
--
-- The existing CHECK constraint on `events.status` is dropped and replaced
-- with the broader enum. This is non-destructive — existing rows remain
-- untouched.
-- ============================================================================

-- ── 1. Extend events.status CHECK constraint ────────────────────────────────

DO $$
DECLARE
  current_constraint TEXT;
BEGIN
  -- Find existing status constraint name
  SELECT conname INTO current_constraint
    FROM pg_constraint
   WHERE conrelid = 'events'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%IN%';

  IF current_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', current_constraint);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'events'::regclass
      AND conname = 'events_status_extended_check'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_status_extended_check
      CHECK (status IN (
        'draft',
        'pending_review',
        'approved',
        'published',
        'hidden',
        'archived',
        'cancelled'
      ));
  END IF;
END $$;

-- ── 2. Add workflow columns to events ───────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'submitted_for_review_at'
  ) THEN
    ALTER TABLE events ADD COLUMN submitted_for_review_at TIMESTAMPTZ DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'approved_at'
  ) THEN
    ALTER TABLE events ADD COLUMN approved_at TIMESTAMPTZ DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'approved_by'
  ) THEN
    ALTER TABLE events ADD COLUMN approved_by BIGINT DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE events ADD COLUMN archived_at TIMESTAMPTZ DEFAULT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_events_approved_by'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT fk_events_approved_by
      FOREIGN KEY (approved_by) REFERENCES admins(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_status_pending
  ON events (status)
  WHERE status = 'pending_review' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_approved_by
  ON events (approved_by)
  WHERE deleted_at IS NULL;


-- ── 3. event_status_history : append-only audit of status transitions ───────

CREATE TABLE IF NOT EXISTS event_status_history (
  id              BIGSERIAL PRIMARY KEY,

  -- The event this row pertains to (soft reference — events are soft-deleted,
  -- so we keep history even after the event itself is purged)
  event_id        BIGINT  NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- The admin who made the change. NULL when triggered by a system action.
  actor_admin_id  BIGINT  DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,

  -- Snapshot of the event's status before and after.
  from_status     VARCHAR(20) DEFAULT NULL,   -- NULL on the very first row (creation)
  to_status       VARCHAR(20) NOT NULL,

  -- Free-form reason. Some transitions require one (e.g. rejection feedback)
  reason          TEXT DEFAULT NULL,

  -- Snapshot of metadata at the time of the change (e.g. request IP, user-agent)
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT event_status_history_to_status_check
    CHECK (to_status IN (
      'draft', 'pending_review', 'approved', 'published',
      'hidden', 'archived', 'cancelled'
    )),

  CONSTRAINT event_status_history_from_status_check
    CHECK (
      from_status IS NULL OR from_status IN (
        'draft', 'pending_review', 'approved', 'published',
        'hidden', 'archived', 'cancelled'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_event_status_history_event
  ON event_status_history (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_status_history_actor
  ON event_status_history (actor_admin_id)
  WHERE actor_admin_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_status_history_to_status
  ON event_status_history (to_status, created_at DESC);


-- ── 4. ANALYZE ──────────────────────────────────────────────────────────────
ANALYZE events;
ANALYZE event_status_history;