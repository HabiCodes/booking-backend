-- ============================================================================
-- Migration 028 — Promotion & Advertisement Engine
-- ============================================================================
-- Creates the complete promotion engine schema: packages, campaigns,
-- impressions, clicks, attributions, inventory slots, and ranking weights.
-- ============================================================================

BEGIN;

-- ── Promotion Packages ────────────────────────────────────────────────────────
-- Admin-defined fixed-price tiers for promotion campaigns.
-- Each package defines: price, duration, impression limit, priority weight,
-- eligible categories, eligible entity types, and supported placements.

CREATE TABLE IF NOT EXISTS promotion_packages (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  description         TEXT,
  price_paise         BIGINT NOT NULL CHECK (price_paise > 0),
  currency            TEXT NOT NULL DEFAULT 'INR',
  duration_days       INTEGER NOT NULL CHECK (duration_days > 0),
  max_impressions     INTEGER NOT NULL CHECK (max_impressions > 0),
  priority_weight     INTEGER NOT NULL DEFAULT 50 CHECK (priority_weight BETWEEN 1 AND 100),
  eligible_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  eligible_entity_types JSONB NOT NULL DEFAULT '["turf_resource","event"]'::jsonb,
  eligible_placements JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  is_featured         BOOLEAN NOT NULL DEFAULT false,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_promotion_packages_slug
  ON promotion_packages(slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_promotion_packages_active
  ON promotion_packages(is_active, sort_order) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS idx_promotion_packages_featured
  ON promotion_packages(is_featured, sort_order) WHERE deleted_at IS NULL AND is_active = true AND is_featured = true;

COMMENT ON TABLE promotion_packages IS 'Admin-defined fixed-price promotion tiers.';
COMMENT ON COLUMN promotion_packages.price_paise IS 'Price in paise (INR * 100). Immutable per package.';
COMMENT ON COLUMN promotion_packages.eligible_categories IS 'JSONB array of category strings (e.g. ["football","cricket"]).';
COMMENT ON COLUMN promotion_packages.eligible_entity_types IS 'JSONB array: ["turf_resource","event"] etc.';
COMMENT ON COLUMN promotion_packages.eligible_placements IS 'JSONB array of placement strings this package supports.';


-- ── Promotion Campaigns ───────────────────────────────────────────────────────
-- Business-purchased promotion campaigns.
-- A campaign links an organization + package + target entity (turf/event).
-- Status lifecycle: DRAFT → PENDING_PAYMENT → ACTIVE → PAUSED → EXPIRED / CANCELLED / DEPLETED.

CREATE TABLE IF NOT EXISTS promotion_campaigns (
  id                      SERIAL PRIMARY KEY,
  organization_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  package_id              INTEGER NOT NULL REFERENCES promotion_packages(id) ON DELETE RESTRICT,
  entity_type             TEXT NOT NULL CHECK (entity_type IN ('turf_resource','event','venue','organization')),
  entity_id               INTEGER NOT NULL,
  entity_name             TEXT NOT NULL,
  entity_image_url        TEXT,
  entity_location         TEXT,
  status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                            'DRAFT','PENDING_PAYMENT','ACTIVE','PAUSED','EXPIRED',
                            'CANCELLED','DEPLETED','REJECTED','REFUNDED'
                          )),
  start_at                TIMESTAMPTZ NOT NULL,
  end_at                  TIMESTAMPTZ NOT NULL,
  max_impressions         INTEGER NOT NULL CHECK (max_impressions >= 0),
  impressions_delivered   INTEGER NOT NULL DEFAULT 0 CHECK (impressions_delivered >= 0),
  clicks                  INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  priority_weight         INTEGER NOT NULL CHECK (priority_weight BETWEEN 1 AND 100),
  config_snapshot          JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_order_id        TEXT,
  total_spend_paise       BIGINT NOT NULL DEFAULT 0 CHECK (total_spend_paise >= 0),
  created_by_organizer_id INTEGER REFERENCES organizer_users(id) ON DELETE SET NULL,
  approved_by_admin_id    INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  approved_at             TIMESTAMPTZ,
  rejection_reason        TEXT,
  cancelled_at            TIMESTAMPTZ,
  paused_at               TIMESTAMPTZ,
  paused_reason           TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at              TIMESTAMPTZ
);

-- Composite index for the most common query: active campaigns for a given entity + time window
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_active_lookup
  ON promotion_campaigns(entity_type, entity_id, status, start_at, end_at)
  WHERE deleted_at IS NULL AND status IN ('ACTIVE','PAUSED');

-- Organization-scoped queries
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_org
  ON promotion_campaigns(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Status queries
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_status
  ON promotion_campaigns(status, end_at)
  WHERE deleted_at IS NULL;

-- Payment order reference
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_payment_order
  ON promotion_campaigns(payment_order_id)
  WHERE payment_order_id IS NOT NULL;

-- Package reference
CREATE INDEX IF NOT EXISTS idx_promotion_campaigns_package
  ON promotion_campaigns(package_id)
  WHERE deleted_at IS NULL;

-- Unique constraint: prevent duplicate campaigns for the same entity + package + active/pending status
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_active_per_entity_package
  ON promotion_campaigns(entity_type, entity_id, package_id)
  WHERE deleted_at IS NULL AND status IN ('ACTIVE','PENDING_PAYMENT','PAUSED');

COMMENT ON TABLE promotion_campaigns IS 'Business-purchased promotion campaigns linked to a specific entity.';
COMMENT ON COLUMN promotion_campaigns.config_snapshot IS 'Immutable snapshot of package config at purchase time.';
COMMENT ON COLUMN promotion_campaigns.total_spend_paise IS 'Total amount paid for this campaign in paise.';
COMMENT ON COLUMN promotion_campaigns.impressions_delivered IS 'Counter updated atomically. Must never exceed max_impressions.';


-- ── Promotion Impressions ────────────────────────────────────────────────────
-- Every delivered impression is recorded here.
-- Idempotency: (campaign_id, request_id, placement) unique where request_id IS NOT NULL.
-- request_id is NULL for organic/list-page loads (no client-generated request ID).

CREATE TABLE IF NOT EXISTS promotion_impressions (
  id                SERIAL PRIMARY KEY,
  campaign_id       INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  placement         TEXT NOT NULL CHECK (placement IN (
                      'HOME_HERO','CATEGORY_FEED','SEARCH_FEED','NEAR_YOU',
                      'LISTING_CARD','DETAIL_PAGE'
                    )),
  position          INTEGER NOT NULL CHECK (position > 0),
  ranking_score     NUMERIC(8,4) NOT NULL DEFAULT 0,
  user_session_id   TEXT,
  request_id        TEXT,
  ip_hash           TEXT,
  user_agent        TEXT,
  device_type       TEXT CHECK (device_type IN ('mobile','desktop','tablet','unknown')),
  location_context  JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_unique         BOOLEAN NOT NULL DEFAULT false,
  delivered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotion_impressions_campaign
  ON promotion_impressions(campaign_id, delivered_at DESC);

CREATE INDEX IF NOT EXISTS idx_promotion_impressions_delivered_at
  ON promotion_impressions(delivered_at);

CREATE INDEX IF NOT EXISTS idx_promotion_impressions_session
  ON promotion_impressions(campaign_id, user_session_id, delivered_at);

CREATE INDEX IF NOT EXISTS idx_promotion_impressions_placement
  ON promotion_impressions(placement, delivered_at DESC);

-- Idempotency: prevent duplicate impressions for the same request
CREATE UNIQUE INDEX IF NOT EXISTS uq_impression_delivery
  ON promotion_impressions(campaign_id, request_id, placement)
  WHERE request_id IS NOT NULL;

COMMENT ON TABLE promotion_impressions IS 'Every delivered promotion impression.';
COMMENT ON COLUMN promotion_impressions.request_id IS 'Client-generated request ID for idempotency. NULL for organic loads.';
COMMENT ON COLUMN promotion_impressions.is_unique IS 'True if this is the first impression from this session for this campaign.';
-- ── Promotion Clicks ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promotion_clicks (
  id              SERIAL PRIMARY KEY,
  campaign_id     INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  impression_id   INTEGER REFERENCES promotion_impressions(id) ON DELETE SET NULL,
  user_session_id TEXT,
  ip_hash         TEXT,
  user_agent      TEXT,
  device_type     TEXT CHECK (device_type IN ('mobile','desktop','tablet','unknown')),
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotion_clicks_campaign
  ON promotion_clicks(campaign_id, clicked_at DESC);

CREATE INDEX IF NOT EXISTS idx_promotion_clicks_impression
  ON promotion_clicks(impression_id)
  WHERE impression_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promotion_clicks_session
  ON promotion_clicks(campaign_id, user_session_id, clicked_at);

COMMENT ON TABLE promotion_clicks IS 'Promotion click tracking.';


-- ── Promotion Attributions ────────────────────────────────────────────────────
-- Links a campaign to a booking with configurable attribution windows.
-- Default: click-through = 7 days, view-through = 24 hours.

CREATE TABLE IF NOT EXISTS promotion_attributions (
  id                       SERIAL PRIMARY KEY,
  campaign_id              INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  booking_id               INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  attribution_type         TEXT NOT NULL CHECK (attribution_type IN ('click','view')),
  attribution_window_hours INTEGER NOT NULL DEFAULT 168 CHECK (attribution_window_hours > 0),
  interaction_at           TIMESTAMPTZ NOT NULL,
  attributed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  booking_amount_paise     BIGINT NOT NULL CHECK (booking_amount_paise >= 0),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_attribution_campaign_booking
  ON promotion_attributions(campaign_id, booking_id);

CREATE INDEX IF NOT EXISTS idx_promotion_attributions_campaign
  ON promotion_attributions(campaign_id, attributed_at DESC);

CREATE INDEX IF NOT EXISTS idx_promotion_attributions_booking
  ON promotion_attributions(booking_id);

CREATE INDEX IF NOT EXISTS idx_promotion_attributions_type
  ON promotion_attributions(attribution_type, attributed_at DESC);

COMMENT ON TABLE promotion_attributions IS 'Attribution records linking campaigns to bookings.';
COMMENT ON COLUMN promotion_attributions.attribution_window_hours IS 'Hours within which a booking is attributed to this interaction.';


-- ── Ad Inventory Slots ────────────────────────────────────────────────────────
-- Controls maximum sponsored slots per location/category/placement combination.
-- Managed by Super Admin.

CREATE TABLE IF NOT EXISTS ad_inventory_slots (
  id          SERIAL PRIMARY KEY,
  location_key TEXT NOT NULL,
  category    TEXT NOT NULL,
  placement   TEXT NOT NULL CHECK (placement IN (
                'HOME_HERO','CATEGORY_FEED','SEARCH_FEED','NEAR_YOU',
                'LISTING_CARD','DETAIL_PAGE'
              )),
  max_slots   INTEGER NOT NULL CHECK (max_slots >= 0),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

-- Partial unique index: one active slot per location/category/placement
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_slot
  ON ad_inventory_slots (location_key, category, placement)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ad_inventory_slots_lookup
  ON ad_inventory_slots(location_key, category, placement)
  WHERE deleted_at IS NULL AND is_active = true;

COMMENT ON TABLE ad_inventory_slots IS 'Sponsored slot inventory limits per location/category/placement.';


-- ── Promotion Rank Weights ────────────────────────────────────────────────────
-- Admin-configurable weights for the hybrid ranking algorithm.
-- Default: priority=50, relevance=30, deficit=20 (sums to 100).

CREATE TABLE IF NOT EXISTS promotion_rank_weights (
  id                  SERIAL PRIMARY KEY,
  w1_priority         INTEGER NOT NULL DEFAULT 50 CHECK (w1_priority >= 0),
  w2_relevance        INTEGER NOT NULL DEFAULT 30 CHECK (w2_relevance >= 0),
  w3_deficit          INTEGER NOT NULL DEFAULT 20 CHECK (w3_deficit >= 0),
  updated_by_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one row expected — enforce singleton
CREATE UNIQUE INDEX IF NOT EXISTS uq_rank_weights_singleton
  ON promotion_rank_weights((1))
  WHERE id = 1;

COMMENT ON TABLE promotion_rank_weights IS 'Admin-configurable ranking weights. Singleton table — one row.';


-- ── Campaign Daily Aggregates ─────────────────────────────────────────────────
-- Pre-computed daily metrics for fast analytics queries.
-- Updated by background worker or trigger after each impression/click/attribution.

CREATE TABLE IF NOT EXISTS promotion_campaign_daily (
  id                SERIAL PRIMARY KEY,
  campaign_id       INTEGER NOT NULL REFERENCES promotion_campaigns(id) ON DELETE CASCADE,
  date              DATE NOT NULL,
  impressions       INTEGER NOT NULL DEFAULT 0,
  unique_impressions INTEGER NOT NULL DEFAULT 0,
  clicks            INTEGER NOT NULL DEFAULT 0,
  unique_clicks     INTEGER NOT NULL DEFAULT 0,
  attributed_bookings INTEGER NOT NULL DEFAULT 0,
  attributed_revenue_paise BIGINT NOT NULL DEFAULT 0,
  spend_paise       BIGINT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campaign_daily UNIQUE (campaign_id, date)
);

CREATE INDEX IF NOT EXISTS idx_promotion_campaign_daily_campaign
  ON promotion_campaign_daily(campaign_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_promotion_campaign_daily_date
  ON promotion_campaign_daily(date);

COMMENT ON TABLE promotion_campaign_daily IS 'Daily pre-aggregated metrics per campaign for analytics.';


-- ── Triggers ──────────────────────────────────────────────────────────────────

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION set_promotion_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_promotion_packages_updated ON promotion_packages;
CREATE TRIGGER tg_promotion_packages_updated
  BEFORE UPDATE ON promotion_packages
  FOR EACH ROW EXECUTE FUNCTION set_promotion_updated_at();

DROP TRIGGER IF EXISTS tg_promotion_campaigns_updated ON promotion_campaigns;
CREATE TRIGGER tg_promotion_campaigns_updated
  BEFORE UPDATE ON promotion_campaigns
  FOR EACH ROW EXECUTE FUNCTION set_promotion_updated_at();

DROP TRIGGER IF EXISTS tg_ad_inventory_slots_updated ON ad_inventory_slots;
CREATE TRIGGER tg_ad_inventory_slots_updated
  BEFORE UPDATE ON ad_inventory_slots
  FOR EACH ROW EXECUTE FUNCTION set_promotion_updated_at();

DROP TRIGGER IF EXISTS tg_promotion_campaign_daily_updated ON promotion_campaign_daily;
CREATE TRIGGER tg_promotion_campaign_daily_updated
  BEFORE UPDATE ON promotion_campaign_daily
  FOR EACH ROW EXECUTE FUNCTION set_promotion_updated_at();


-- ── Seed default rank weights ─────────────────────────────────────────────────
INSERT INTO promotion_rank_weights (id, w1_priority, w2_relevance, w3_deficit, updated_at)
VALUES (1, 50, 30, 20, NOW())
ON CONFLICT (id) DO NOTHING;

COMMIT;
