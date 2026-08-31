-- ============================================================================
-- Migration 049: Free event zone protection (DB-level enforcement)
-- ============================================================================
-- Defense-in-depth: Even if application-layer validation is bypassed,
-- this trigger prevents zone rows from being created for free events.
--
-- Rules enforced:
--   - Cannot INSERT a zone for an event where is_free = true
--   - Cannot UPDATE a zone to point to a free event
--   - Cannot set is_free = true on an event that has active zones (via event update)

-- ── 1. Trigger: prevent zone creation for free events ─────────────────────────

CREATE OR REPLACE FUNCTION prevent_zone_on_free_event()
RETURNS TRIGGER AS $$
DECLARE
  v_is_free BOOLEAN;
BEGIN
  -- Check if the target event is a free event
  SELECT is_free INTO v_is_free
  FROM events
  WHERE id = NEW.event_id AND deleted_at IS NULL;

  IF v_is_free THEN
    RAISE EXCEPTION 'Cannot add zones to a free event (event_id=%)', NEW.event_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_zone_on_free_event'
  ) THEN
    CREATE TRIGGER trg_prevent_zone_on_free_event
      BEFORE INSERT OR UPDATE OF event_id ON event_zones
      FOR EACH ROW
      EXECUTE FUNCTION prevent_zone_on_free_event();
  END IF;
END $$;

-- ── 2. Trigger: prevent converting event to free if it has zones ───────────────

CREATE OR REPLACE FUNCTION prevent_free_event_with_zones()
RETURNS TRIGGER AS $$
DECLARE
  v_zone_count INTEGER;
BEGIN
  -- Only act when is_free is being SET TO true (new.is_free = true and old was false/null)
  IF NEW.is_free = true AND (OLD.is_free IS NULL OR OLD.is_free = false) THEN
    SELECT COUNT(*) INTO v_zone_count
    FROM event_zones
    WHERE event_id = NEW.id AND deleted_at IS NULL;

    IF v_zone_count > 0 THEN
      RAISE EXCEPTION 'Cannot set event as free while it has zones (event_id=%, zone_count=%). Delete all zones first.', NEW.id, v_zone_count;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_free_event_with_zones'
  ) THEN
    CREATE TRIGGER trg_prevent_free_event_with_zones
      BEFORE UPDATE OF is_free ON events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_free_event_with_zones();
  END IF;
END $$;

-- ── 3. ANALYZE ──────────────────────────────────────────────────────────────────

ANALYZE event_zones;
