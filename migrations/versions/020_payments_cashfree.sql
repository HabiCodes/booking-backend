-- ============================================================================
-- Migration 020: Cashfree Payment Orders, Webhooks, Refunds
-- ============================================================================

-- ── payment_orders ─────────────────────────────────────────────────────────────
-- Every payment intent is recorded here. Cashfree credentials remain server-side.
-- The source of truth for payment status is the Cashfree webhook + server-side
-- verification; never trust client-supplied success flags.

CREATE TABLE IF NOT EXISTS payment_orders (
  id                BIGSERIAL PRIMARY KEY,

  -- Identity
  order_id          VARCHAR(80) NOT NULL UNIQUE,
  booking_id        BIGINT      NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,

  -- Tenant
  organization_id   BIGINT      NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_id          BIGINT      NOT NULL REFERENCES events(id) ON DELETE RESTRICT,

  -- Amount
  amount            NUMERIC(12, 2) NOT NULL,
  currency          VARCHAR(3)  NOT NULL DEFAULT 'INR',

  -- Cashfree
  cf_payment_id     VARCHAR(80) DEFAULT NULL,
  cf_order_token    TEXT         DEFAULT NULL,
  cf_payment_session_id VARCHAR(80) DEFAULT NULL,
  cf_authorization_id  VARCHAR(80) DEFAULT NULL,

  -- Lifecycle
  status            VARCHAR(20) NOT NULL DEFAULT 'CREATED'
    CHECK (status IN ('CREATED', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  payment_method    VARCHAR(40) DEFAULT NULL,

  -- Links
  payment_gateway   VARCHAR(20) NOT NULL DEFAULT 'cashfree',

  -- Result
  error_code        VARCHAR(40) DEFAULT NULL,
  error_message     TEXT      DEFAULT NULL,

  -- Verification
  verified_at       TIMESTAMPTZ DEFAULT NULL,
  verified_by       VARCHAR(20) DEFAULT NULL CHECK (verified_by IN ('webhook', 'api_poll')),

  -- Idempotency
  idempotency_key   VARCHAR(80) DEFAULT NULL UNIQUE,

  -- Retry
  retry_count       INTEGER    NOT NULL DEFAULT 0,

  -- Audit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_booking
  ON payment_orders (booking_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_organization
  ON payment_orders (organization_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_event
  ON payment_orders (event_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status
  ON payment_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_order_id
  ON payment_orders (order_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_idempotency
  ON payment_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Auto-update
CREATE OR REPLACE FUNCTION payment_orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_orders_updated_at'
  ) THEN
    CREATE TRIGGER trg_payment_orders_updated_at
      BEFORE UPDATE ON payment_orders
      FOR EACH ROW
      EXECUTE FUNCTION payment_orders_set_updated_at();
  END IF;
END $$;


-- ── refunds ────────────────────────────────────────────────────────────────────
-- Refund records. Supports partial refunds (refund_id includes booking reference).

CREATE TABLE IF NOT EXISTS refunds (
  id                BIGSERIAL PRIMARY KEY,
  payment_order_id  BIGINT NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  booking_id        BIGINT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,

  -- Cashfree refund reference
  cf_refund_id      VARCHAR(80) DEFAULT NULL,
  cf_refund_status  VARCHAR(20) DEFAULT NULL,

  -- Amount
  amount            NUMERIC(12, 2) NOT NULL,
  currency          VARCHAR(3)  NOT NULL DEFAULT 'INR',

  -- Reason
  reason            TEXT      DEFAULT NULL,
  refund_type       VARCHAR(20) NOT NULL DEFAULT 'customer_initiated'
    CHECK (refund_type IN ('customer_initiated', 'organizer_initiated', 'admin_initiated', 'fraud', 'payment_failure')),

  -- Status
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED')),

  -- Auditor
  created_by_admin_id BIGINT DEFAULT NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_by_user_id  BIGINT DEFAULT NULL REFERENCES organizer_users(id) ON DELETE SET NULL,

  -- Timestamps
  processed_at      TIMESTAMPTZ DEFAULT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment_order
  ON refunds (payment_order_id);

CREATE INDEX IF NOT EXISTS idx_refunds_booking
  ON refunds (booking_id);

CREATE INDEX IF NOT EXISTS idx_refunds_status
  ON refunds (status, created_at DESC);

CREATE OR REPLACE FUNCTION refunds_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_refunds_updated_at'
  ) THEN
    CREATE TRIGGER trg_refunds_updated_at
      BEFORE UPDATE ON refunds
      FOR EACH ROW
      EXECUTE FUNCTION refunds_set_updated_at();
  END IF;
END $$;


-- ── webhook_events ─────────────────────────────────────────────────────────────
-- Idempotent webhook processing. Each Cashfree webhook is recorded once.

CREATE TABLE IF NOT EXISTS webhook_events (
  id                BIGSERIAL PRIMARY KEY,

  -- Source
  source            VARCHAR(20) NOT NULL DEFAULT 'cashfree',
  event_type        VARCHAR(60) NOT NULL,

  -- Idempotency
  event_id          VARCHAR(120) NOT NULL,
  idempotency_key   VARCHAR(120) NOT NULL,

  -- Payload
  raw_payload       JSONB NOT NULL,

  -- Processing
  processed_at      TIMESTAMPTZ DEFAULT NULL,
  processing_error  TEXT      DEFAULT NULL,
  related_order_id  VARCHAR(80) DEFAULT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_idempotency
  ON webhook_events (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON webhook_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_order
  ON webhook_events (related_order_id)
  WHERE related_order_id IS NOT NULL;


-- ── 4. Extend bookings with payment reference ──────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bookings' AND column_name = 'payment_order_id'
  ) THEN
    ALTER TABLE bookings ADD COLUMN payment_order_id BIGINT DEFAULT NULL
      REFERENCES payment_orders(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_payment_order
  ON bookings (payment_order_id)
  WHERE payment_order_id IS NOT NULL;


-- ── ANALYZE ───────────────────────────────────────────────────────────────────

ANALYZE payment_orders;
ANALYZE refunds;
ANALYZE webhook_events;
ANALYZE bookings;
