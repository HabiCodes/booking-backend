-- ============================================================================
-- Migration 022 — Turf Domain (sports turf booking platform)
-- ============================================================================
-- Independent domain.  Uses the main backend's users, organizations,
-- organizer_users, and Cashfree payment infrastructure where applicable.
-- Turf-specific tables live under the "turf_" prefix to avoid collision
-- with the event domain's "venues", "bookings", "qr_tickets", etc.

-- ── Turf-specific venue (turf field) ────────────────────────────────────────
-- Distinct from the event-domain "venues" table.  A "turf_venue" is a
-- bookable sports ground / field managed by an organizer organization.

CREATE TABLE IF NOT EXISTS turf_venues (
    id              SERIAL PRIMARY KEY,
    organization_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    address         VARCHAR(500),
    city            VARCHAR(100),
    state           VARCHAR(100),
    country         VARCHAR(100) DEFAULT 'India',
    latitude        NUMERIC(10,7),
    longitude       NUMERIC(10,7),
    amenities       TEXT[] DEFAULT '{}',
    status          VARCHAR(20) DEFAULT 'pending',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_turf_venues_org ON turf_venues(organization_id);
CREATE INDEX IF NOT EXISTS idx_turf_venues_city ON turf_venues(city);
CREATE INDEX IF NOT EXISTS idx_turf_venues_status ON turf_venues(status);

-- ── Bookable Resources (grounds / courts / zones) ───────────────────────────
-- Each resource belongs to a turf_venue and has a resource_type:
--   slot_based  → time slots (e.g. football ground, 1-hour slots)
--   seat_based  → numbered seats (e.g. badminton court seats)
--   zone_based  → named zones (e.g. tennis court A, B, C)

CREATE TABLE IF NOT EXISTS turf_resources (
    id              SERIAL PRIMARY KEY,
    venue_id        INT NOT NULL REFERENCES turf_venues(id) ON DELETE CASCADE,
    resource_type   VARCHAR(20) NOT NULL CHECK (resource_type IN ('slot_based','seat_based','zone_based')),
    category        VARCHAR(100) NOT NULL,
    name            VARCHAR(200) NOT NULL,
    base_price      NUMERIC(10,2) NOT NULL DEFAULT 0,
    attributes      JSONB DEFAULT '{}',
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_turf_resources_venue ON turf_resources(venue_id);
CREATE INDEX IF NOT EXISTS idx_turf_resources_type ON turf_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_turf_resources_category ON turf_resources(category);

-- ── Availability Units (individual slots / seats / zones for a date) ────────

CREATE TABLE IF NOT EXISTS turf_availability_units (
    id                SERIAL PRIMARY KEY,
    resource_id       INT NOT NULL REFERENCES turf_resources(id) ON DELETE CASCADE,
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    price             NUMERIC(10,2),
    seat_label        VARCHAR(50),
    total_capacity    INT,
    capacity_remaining INT DEFAULT 0,
    status            VARCHAR(20) DEFAULT 'available',
    lock_holder_id    INT REFERENCES users(id) ON DELETE SET NULL,
    lock_expires_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_au_resource_slot
    ON turf_availability_units (resource_id, starts_at, ends_at)
    WHERE seat_label IS NULL AND total_capacity IS NULL;

CREATE INDEX IF NOT EXISTS idx_turf_au_resource ON turf_availability_units(resource_id);
CREATE INDEX IF NOT EXISTS idx_turf_au_status ON turf_availability_units(status);
CREATE INDEX IF NOT EXISTS idx_turf_au_starts ON turf_availability_units(starts_at);

-- ── Turf Bookings ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_bookings (
    id                  SERIAL PRIMARY KEY,
    booking_reference   VARCHAR(20) UNIQUE NOT NULL,
    user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id     INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    venue_id            INT NOT NULL REFERENCES turf_venues(id) ON DELETE CASCADE,
    resource_id         INT NOT NULL REFERENCES turf_resources(id) ON DELETE CASCADE,
    availability_unit_id INT NOT NULL REFERENCES turf_availability_units(id) ON DELETE CASCADE,
    booking_type        VARCHAR(20) DEFAULT 'online',
    offline_by_user_id  INT REFERENCES organizer_users(id) ON DELETE SET NULL,
    quantity            INT DEFAULT 1,
    amount              NUMERIC(10,2) NOT NULL,
    currency            VARCHAR(3) DEFAULT 'INR',
    status              VARCHAR(20) DEFAULT 'pending_payment',
    payment_status      VARCHAR(20) DEFAULT 'initiated',
    payment_gateway_ref VARCHAR(200),
    cancellation_reason TEXT,
    cancelled_by        VARCHAR(20),
    cancellation_fee    NUMERIC(10,2) DEFAULT 0,
    notes               TEXT,
    metadata            JSONB DEFAULT '{}',
    version             INT DEFAULT 1,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

CREATE SEQUENCE IF NOT EXISTS turf_bookings_seq START 100001;

CREATE INDEX IF NOT EXISTS idx_turf_bookings_user ON turf_bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_turf_bookings_org ON turf_bookings(organization_id);
CREATE INDEX IF NOT EXISTS idx_turf_bookings_venue ON turf_bookings(venue_id);
CREATE INDEX IF NOT EXISTS idx_turf_bookings_status ON turf_bookings(status);
CREATE INDEX IF NOT EXISTS idx_turf_bookings_ref ON turf_bookings(booking_reference);
CREATE INDEX IF NOT EXISTS idx_turf_bookings_au ON turf_bookings(availability_unit_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_booking_au_confirmed
    ON turf_bookings (availability_unit_id)
    WHERE status IN ('confirmed', 'checked_in', 'completed');

-- ── Turf QR Tickets ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_qr_tickets (
    id          SERIAL PRIMARY KEY,
    booking_id  INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    token       VARCHAR(128) UNIQUE NOT NULL,
    status      VARCHAR(20) DEFAULT 'issued',
    used_at     TIMESTAMPTZ,
    used_by     INT REFERENCES organizer_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_qr_booking ON turf_qr_tickets(booking_id);
CREATE INDEX IF NOT EXISTS idx_turf_qr_token ON turf_qr_tickets(token);

-- ── Turf Coupons ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_coupons (
    id                  SERIAL PRIMARY KEY,
    organization_id     INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code                VARCHAR(50) NOT NULL,
    description         TEXT,
    discount_type       VARCHAR(20) NOT NULL,
    discount_value      NUMERIC(10,2) NOT NULL,
    min_booking_amount  NUMERIC(10,2) DEFAULT 0,
    max_discount        NUMERIC(10,2),
    usage_limit         INT,
    used_count          INT DEFAULT 0,
    per_user_limit      INT DEFAULT 1,
    valid_from          TIMESTAMPTZ DEFAULT NOW(),
    valid_until         TIMESTAMPTZ NOT NULL,
    applicable_resource_ids INT[] DEFAULT '{}',
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_coupon_org_code ON turf_coupons(organization_id, UPPER(code));
CREATE INDEX IF NOT EXISTS idx_turf_coupons_org ON turf_coupons(organization_id);

-- ── Turf Coupon Usages ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_coupon_usages (
    id              SERIAL PRIMARY KEY,
    coupon_id       INT NOT NULL REFERENCES turf_coupons(id) ON DELETE CASCADE,
    booking_id      INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    discount_amount NUMERIC(10,2) NOT NULL,
    status          VARCHAR(20) DEFAULT 'reserved',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_coupon_usages_coupon ON turf_coupon_usages(coupon_id);
CREATE INDEX IF NOT EXISTS idx_turf_coupon_usages_booking ON turf_coupon_usages(booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_coupon_usage ON turf_coupon_usages(coupon_id, booking_id);

-- ── Turf Settlements ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_settlements (
    id                  SERIAL PRIMARY KEY,
    organization_id     INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    gross_amount        NUMERIC(12,2) DEFAULT 0,
    commission_amount   NUMERIC(12,2) DEFAULT 0,
    tax_amount          NUMERIC(12,2) DEFAULT 0,
    net_amount          NUMERIC(12,2) DEFAULT 0,
    status              VARCHAR(20) DEFAULT 'pending',
    gateway_payout_id   VARCHAR(200),
    scheduled_at        TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours',
    completed_at        TIMESTAMPTZ,
    failure_reason      TEXT,
    retry_count         INT DEFAULT 0,
    max_retries         INT DEFAULT 3,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_settlements_org ON turf_settlements(organization_id);
CREATE INDEX IF NOT EXISTS idx_turf_settlements_status ON turf_settlements(status);

-- ── Turf Settlement Items ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_settlement_items (
    id                  SERIAL PRIMARY KEY,
    settlement_id       INT NOT NULL REFERENCES turf_settlements(id) ON DELETE CASCADE,
    booking_id          INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    gross_amount        NUMERIC(10,2) NOT NULL,
    commission_amount   NUMERIC(10,2) NOT NULL,
    tax_amount          NUMERIC(10,2) NOT NULL,
    net_amount          NUMERIC(10,2) NOT NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_settlement_items_settlement ON turf_settlement_items(settlement_id);
CREATE INDEX IF NOT EXISTS idx_turf_settlement_items_booking ON turf_settlement_items(booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_settlement_item_booking ON turf_settlement_items(settlement_id, booking_id);

-- ── Turf Refunds ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_refunds (
    id                  SERIAL PRIMARY KEY,
    settlement_item_id  INT REFERENCES turf_settlement_items(id) ON DELETE SET NULL,
    booking_id          INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    amount              NUMERIC(10,2) NOT NULL,
    currency            VARCHAR(3) DEFAULT 'INR',
    reason              TEXT,
    refund_type         VARCHAR(20) DEFAULT 'customer_initiated',
    status              VARCHAR(20) DEFAULT 'PENDING',
    gateway_refund_id   VARCHAR(200),
    processed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_refunds_booking ON turf_refunds(booking_id);
CREATE INDEX IF NOT EXISTS idx_turf_refunds_status ON turf_refunds(status);

-- ── Turf Wallet Transactions ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_wallet_transactions (
    id              SERIAL PRIMARY KEY,
    user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    coins           INT NOT NULL,
    balance_after   INT NOT NULL,
    type            VARCHAR(30) NOT NULL,
    category        VARCHAR(30),
    booking_id      INT REFERENCES turf_bookings(id) ON DELETE SET NULL,
    description     TEXT,
    actor_type      VARCHAR(20),
    actor_id        INT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_wallet_user ON turf_wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_turf_wallet_org ON turf_wallet_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_turf_wallet_booking ON turf_wallet_transactions(booking_id);

-- ── Turf Reviews ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_reviews (
    id          SERIAL PRIMARY KEY,
    venue_id    INT NOT NULL REFERENCES turf_venues(id) ON DELETE CASCADE,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id  INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    rating      INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review      TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_turf_review_booking ON turf_reviews(booking_id);
CREATE INDEX IF NOT EXISTS idx_turf_reviews_venue ON turf_reviews(venue_id);
CREATE INDEX IF NOT EXISTS idx_turf_reviews_user ON turf_reviews(user_id);

-- ── Turf Booking Audit Log ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_booking_audits (
    id          SERIAL PRIMARY KEY,
    booking_id  INT NOT NULL REFERENCES turf_bookings(id) ON DELETE CASCADE,
    ticket_id   INT REFERENCES turf_qr_tickets(id) ON DELETE SET NULL,
    actor_type  VARCHAR(20) NOT NULL,
    actor_id    INT,
    action      VARCHAR(50) NOT NULL,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_audit_booking ON turf_booking_audits(booking_id);
CREATE INDEX IF NOT EXISTS idx_turf_audit_created ON turf_booking_audits(created_at);

-- ── Turf Search Cache ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS turf_search_cache (
    id          SERIAL PRIMARY KEY,
    cache_key   VARCHAR(200) UNIQUE NOT NULL,
    payload     JSONB NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turf_search_cache_key ON turf_search_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_turf_search_cache_expires ON turf_search_cache(expires_at);
