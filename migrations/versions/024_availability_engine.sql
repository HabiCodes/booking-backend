-- ============================================================================
-- Migration 024 — Availability Engine (operating hours, blocked periods, holds)
-- ============================================================================

-- ── Operating Hours / Schedules ──────────────────────────────────────────────
-- Per-resource schedule.  A resource can have multiple schedule entries
-- (e.g. "09:00-13:00" and "14:00-23:00" on Monday).
-- day_of_week: 0=Sunday … 6=Saturday (JS getDay() convention)
--
-- If a resource has no schedule entries, it is treated as "always available"
-- during its slot-based availability units.

CREATE TABLE IF NOT EXISTS turf_resource_schedules (
    id              SERIAL PRIMARY KEY,
    resource_id     INT NOT NULL REFERENCES turf_resources(id) ON DELETE CASCADE,
    day_of_week     INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    open_time      VARCHAR(5) NOT NULL,   -- "HH:MM" 24h
    close_time     VARCHAR(5) NOT NULL,   -- "HH:MM" 24h
    is_active      BOOLEAN DEFAULT TRUE,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT uq_turf_schedule_resource_day
        UNIQUE (resource_id, day_of_week, open_time, close_time)
);

CREATE INDEX IF NOT EXISTS idx_turf_schedule_resource
    ON turf_resource_schedules(resource_id, day_of_week);

-- ── Blocked Periods ──────────────────────────────────────────────────────────
-- Ad-hoc blocks (maintenance, private events, weather, admin blocks).
-- These take precedence over schedule + availability units.

CREATE TABLE IF NOT EXISTS turf_blocked_periods (
    id              SERIAL PRIMARY KEY,
    organization_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    venue_id        INT REFERENCES turf_venues(id) ON DELETE CASCADE,
    resource_id     INT REFERENCES turf_resources(id) ON DELETE CASCADE,
    reason          VARCHAR(200),
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    created_by      INT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT chk_turf_blocked_range CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_turf_blocked_org ON turf_blocked_periods(organization_id);
CREATE INDEX IF NOT EXISTS idx_turf_blocked_venue ON turf_blocked_periods(venue_id);
CREATE INDEX IF NOT EXISTS idx_turf_blocked_resource ON turf_blocked_periods(resource_id);
CREATE INDEX IF NOT EXISTS idx_turf_blocked_range ON turf_blocked_periods(starts_at, ends_at);

-- ── Hold Tokens (Redis-backed payment holds) ─────────────────────────────────
-- Records the lifecycle of a hold.  Redis is the fast-path check;
-- this table is the durable record used for reconciliation and expiry.

CREATE TABLE IF NOT EXISTS turf_holds (
    id              SERIAL PRIMARY KEY,
    availability_unit_id INT NOT NULL REFERENCES turf_availability_units(id) ON DELETE CASCADE,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           VARCHAR(128) UNIQUE NOT NULL,
    status          VARCHAR(20) DEFAULT 'active',  -- active | confirmed | expired | released
    booking_id      INT REFERENCES turf_bookings(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    released_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_hold_active_unit
    ON turf_holds (availability_unit_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_turf_holds_token ON turf_holds(token);
CREATE INDEX IF NOT EXISTS idx_turf_holds_user ON turf_holds(user_id);
CREATE INDEX IF NOT EXISTS idx_turf_holds_status ON turf_holds(status);
CREATE INDEX IF NOT EXISTS idx_turf_holds_expires ON turf_holds(expires_at);
