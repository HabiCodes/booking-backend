-- ============================================================================
-- Migration 017: Venues, Ticket Tiers, Seating, Check-ins
-- ============================================================================
-- These tables are all tenant-scoped (linked via organization_id).
-- ============================================================================


-- ── 1. venues ─────────────────────────────────────────────────────────────────
-- Venues can be owned by an organization (for their events) or be a shared
-- system venue (organization_id IS NULL, managed by Super Admin).

CREATE TABLE IF NOT EXISTS venues (
  id              BIGSERIAL PRIMARY KEY,
  organization_id BIGINT DEFAULT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name            VARCHAR(255) NOT NULL,
  address         TEXT         DEFAULT NULL,
  city            VARCHAR(120) DEFAULT NULL,
  state           VARCHAR(120) DEFAULT NULL,
  country         VARCHAR(120) DEFAULT NULL,
  latitude        DOUBLE PRECISION DEFAULT NULL,
  longitude       DOUBLE PRECISION DEFAULT NULL,

  -- Venue configuration
  capacity        INTEGER      DEFAULT NULL,
  seating_map     JSONB        DEFAULT '{}'::jsonb,
  notes           TEXT         DEFAULT NULL,

  -- Lifecycle
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  deleted_at      TIMESTAMPTZ  DEFAULT NULL,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_venues_organization
  ON venues (organization_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_venues_active
  ON venues (organization_id, is_active)
  WHERE deleted_at IS NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION venues_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_venues_updated_at'
  ) THEN
    CREATE TRIGGER trg_venues_updated_at
      BEFORE UPDATE ON venues
      FOR EACH ROW
      EXECUTE FUNCTION venues_set_updated_at();
  END IF;
END $$;


-- ── 2. ticket_tiers ────────────────────────────────────────────────────────────
-- Per-event ticket pricing tiers. Both reserved seating and general admission
-- are supported via the `type` field.

CREATE TABLE IF NOT EXISTS ticket_tiers (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  name            VARCHAR(255) NOT NULL,
  description     TEXT         DEFAULT NULL,

  -- 'general' = general admission, 'reserved' = assigned seats
  type            VARCHAR(20)  NOT NULL DEFAULT 'general'
    CHECK (type IN ('general', 'reserved')),

  -- Pricing
  price           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  currency        VARCHAR(3)  NOT NULL DEFAULT 'INR',

  -- Capacity
  total_quantity  INTEGER NOT NULL DEFAULT 0,
  sold_quantity   INTEGER NOT NULL DEFAULT 0,

  -- Sales window
  sale_starts_at  TIMESTAMPTZ DEFAULT NULL,
  sale_ends_at    TIMESTAMPTZ DEFAULT NULL,

  -- Status
  status          VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'sold_out', 'archived')),

  -- Metadata
  metadata        JSONB       DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_tiers_event
  ON ticket_tiers (event_id);

CREATE INDEX IF NOT EXISTS idx_ticket_tiers_event_status
  ON ticket_tiers (event_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_tiers_event_name
  ON ticket_tiers (event_id, name)
  WHERE deleted_at IS NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION ticket_tiers_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ticket_tiers_updated_at'
  ) THEN
    CREATE TRIGGER trg_ticket_tiers_updated_at
      BEFORE UPDATE ON ticket_tiers
      FOR EACH ROW
      EXECUTE FUNCTION ticket_tiers_set_updated_at();
  END IF;
END $$;


-- ── 3. seats ───────────────────────────────────────────────────────────────────
-- Individual seats for reserved seating events. Only relevant when a ticket
-- tier has type = 'reserved'.

CREATE TABLE IF NOT EXISTS seats (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tier_id         BIGINT DEFAULT NULL REFERENCES ticket_tiers(id) ON DELETE SET NULL,

  -- Seat identification
  section         VARCHAR(50)  NOT NULL DEFAULT 'A',
  row_label       VARCHAR(10)  NOT NULL DEFAULT '1',
  seat_number     INTEGER      NOT NULL,

  -- Seat metadata
  label           VARCHAR(20)  DEFAULT NULL,
  seat_type       VARCHAR(20)  DEFAULT 'standard'
    CHECK (seat_type IN ('standard', 'vip', 'premium', 'accessible', 'wheelchair')),

  -- Availability
  is_available    BOOLEAN      NOT NULL DEFAULT true,
  is_reserved     BOOLEAN      NOT NULL DEFAULT false,
  is_held         BOOLEAN      NOT NULL DEFAULT false,

  -- Hold expiry (for in-progress bookings)
  hold_expires_at TIMESTAMPTZ  DEFAULT NULL,
  hold_booking_id BIGINT       DEFAULT NULL,

  -- Metadata
  metadata        JSONB        DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_event_seat UNIQUE (event_id, section, row_label, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seats_event
  ON seats (event_id);

CREATE INDEX IF NOT EXISTS idx_seats_tier
  ON seats (tier_id)
  WHERE tier_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seats_available
  ON seats (event_id, is_available)
  WHERE is_available = true;

CREATE INDEX IF NOT EXISTS idx_seats_hold
  ON seats (hold_expires_at)
  WHERE is_held = true;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION seats_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_seats_updated_at'
  ) THEN
    CREATE TRIGGER trg_seats_updated_at
      BEFORE UPDATE ON seats
      FOR EACH ROW
      EXECUTE FUNCTION seats_set_updated_at();
  END IF;
END $$;


-- ── 4. booking_seats (join table for reserved bookings) ───────────────────────
-- Links tickets to specific seats. One ticket = one seat.

CREATE TABLE IF NOT EXISTS booking_seats (
  id            BIGSERIAL PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  seat_id       BIGINT NOT NULL REFERENCES seats(id) ON DELETE RESTRICT,
  ticket_id     BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_booking_seat UNIQUE (booking_id, seat_id),
  CONSTRAINT uq_seat_ticket UNIQUE (seat_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_booking_seats_booking
  ON booking_seats (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_seats_seat
  ON booking_seats (seat_id);


-- ── 5. check_ins ──────────────────────────────────────────────────────────────
-- Append-only log of every QR scan / check-in attempt.
-- This is the authoritative source for check-in analytics.

CREATE TABLE IF NOT EXISTS check_ins (
  id              BIGSERIAL PRIMARY KEY,
  ticket_id       BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_id        BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Who scanned
  scanned_by      BIGINT NOT NULL REFERENCES organizer_users(id),

  -- Result
  status          VARCHAR(20) NOT NULL
    CHECK (status IN ('VALID', 'ALREADY_SCANNED', 'INVALID', 'EXPIRED', 'CANCELLED', 'WRONG_EVENT')),

  -- Context
  metadata        JSONB        DEFAULT '{}'::jsonb,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_check_ins_ticket
  ON check_ins (ticket_id);

CREATE INDEX IF NOT EXISTS idx_check_ins_event
  ON check_ins (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_check_ins_scanner
  ON check_ins (scanned_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_check_ins_status_event
  ON check_ins (event_id, status)
  WHERE created_at > NOW() - INTERVAL '90 days';


-- ── ANALYZE ───────────────────────────────────────────────────────────────────

ANALYZE venues;
ANALYZE ticket_tiers;
ANALYZE seats;
ANALYZE booking_seats;
ANALYZE check_ins;
