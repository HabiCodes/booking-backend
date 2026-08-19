-- ============================================================================
-- Migration 033: Movie Ticket Booking Domain
-- ============================================================================
-- Tables: movies, cinemas, cinema_screens, cinema_seats, showtimes,
--         movie_bookings, movie_booking_items, movie_tickets,
--         movie_price_caps, movie_booking_audits
-- ============================================================================


-- ============================================================================
-- 1. Movies
-- ============================================================================

CREATE TABLE IF NOT EXISTS movies (
  id                SERIAL PRIMARY KEY,
  title             VARCHAR(255) NOT NULL,
  original_title    VARCHAR(255),
  slug              VARCHAR(300) UNIQUE NOT NULL,
  synopsis          TEXT,
  genre             VARCHAR(100)[] DEFAULT '{}',
  language          VARCHAR(50) NOT NULL DEFAULT 'Tamil',
  duration_minutes  INTEGER,
  "cast"             TEXT[] DEFAULT '{}',
  director          VARCHAR(255),
  poster_url        VARCHAR(500),
  backdrop_url      VARCHAR(500),
  trailer_url       VARCHAR(500),
  rating            NUMERIC(3,1),
  censor_rating     VARCHAR(10),
  release_date      DATE,
  status            VARCHAR(20) NOT NULL DEFAULT 'coming_soon'
                     CHECK (status IN ('coming_soon', 'now_showing', 'ended')),
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  is_featured       BOOLEAN NOT NULL DEFAULT false,
  metadata          JSONB DEFAULT '{}',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movies_status       ON movies (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movies_release_date ON movies (release_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movies_organization ON movies (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movies_language     ON movies (language) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movies_slug         ON movies (slug);
CREATE INDEX IF NOT EXISTS idx_movies_gin_genre    ON movies USING GIN (genre) WHERE deleted_at IS NULL;


-- ============================================================================
-- 2. Cinemas
-- ============================================================================

CREATE TABLE IF NOT EXISTS cinemas (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  slug              VARCHAR(300) UNIQUE NOT NULL,
  address           TEXT NOT NULL,
  city              VARCHAR(100) NOT NULL,
  state             VARCHAR(100) NOT NULL DEFAULT 'Tamil Nadu',
  country           VARCHAR(100) NOT NULL DEFAULT 'India',
  pincode           VARCHAR(10),
  latitude          NUMERIC(9,6),
  longitude         NUMERIC(9,6),
  phone             VARCHAR(20),
  email             VARCHAR(255),
  facilities        TEXT[] DEFAULT '{}',
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'inactive', 'maintenance')),
  metadata          JSONB DEFAULT '{}',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cinemas_city         ON cinemas (city) WHERE deleted_at IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_cinemas_organization ON cinemas (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cinemas_state        ON cinemas (state) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cinemas_slug         ON cinemas (slug);


-- ============================================================================
-- 3. Cinema Screens
-- ============================================================================

CREATE TABLE IF NOT EXISTS cinema_screens (
  id                SERIAL PRIMARY KEY,
  cinema_id         INTEGER NOT NULL REFERENCES cinemas(id) ON DELETE CASCADE,
  screen_number     INTEGER NOT NULL,
  name              VARCHAR(100),
  seat_capacity     INTEGER NOT NULL,
  screen_type       VARCHAR(50) DEFAULT 'standard'
                     CHECK (screen_type IN ('standard', 'imax', 'dolby', '4dx', 'screenx', 'gold_class')),
  sound_system      VARCHAR(50) DEFAULT 'dolby',
  screen_width      NUMERIC(6,2),
  screen_height     NUMERIC(6,2),
  row_labels        TEXT[] DEFAULT '{}',
  seats_per_row     INTEGER[] DEFAULT '{}',
  seat_start_number INTEGER DEFAULT 1,
  seat_types        JSONB DEFAULT '{}',
  pricing_rules     JSONB DEFAULT '{}',
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cinema_id, screen_number)
);

CREATE INDEX IF NOT EXISTS idx_cinema_screens_cinema ON cinema_screens (cinema_id) WHERE is_active = true;


-- ============================================================================
-- 4. Cinema Seats
-- ============================================================================

CREATE TABLE IF NOT EXISTS cinema_seats (
  id                SERIAL PRIMARY KEY,
  screen_id         INTEGER NOT NULL REFERENCES cinema_screens(id) ON DELETE CASCADE,
  row_label         VARCHAR(5) NOT NULL,
  seat_number       INTEGER NOT NULL,
  seat_type         VARCHAR(20) NOT NULL DEFAULT 'standard'
                     CHECK (seat_type IN ('standard', 'premium', 'sofa', 'wheelchair')),
  seat_category     VARCHAR(20) NOT NULL DEFAULT 'regular'
                     CHECK (seat_category IN ('regular', 'couple', 'recliner')),
  x_position        NUMERIC(6,2),
  y_position        NUMERIC(6,2),
  is_available      BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (screen_id, row_label, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_cinema_seats_screen ON cinema_seats (screen_id) WHERE is_available = true;


-- ============================================================================
-- 5. Showtimes
-- ============================================================================

CREATE TABLE IF NOT EXISTS showtimes (
  id                SERIAL PRIMARY KEY,
  movie_id          INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  cinema_id         INTEGER NOT NULL REFERENCES cinemas(id) ON DELETE RESTRICT,
  screen_id         INTEGER NOT NULL REFERENCES cinema_screens(id) ON DELETE RESTRICT,
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  show_datetime     TIMESTAMPTZ NOT NULL,
  end_datetime      TIMESTAMPTZ NOT NULL,
  language          VARCHAR(50) NOT NULL DEFAULT 'Tamil',
  format            VARCHAR(20) DEFAULT '2D'
                     CHECK (format IN ('2D', '3D', 'IMAX 2D', 'IMAX 3D', '4DX', 'ScreenX')),
  price             INTEGER NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
  total_seats       INTEGER NOT NULL,
  available_seats   INTEGER NOT NULL,
  booked_seats      INTEGER NOT NULL DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'on_sale', 'sold_out', 'cancelled', 'completed', 'hidden')),
  is_hidden         BOOLEAN NOT NULL DEFAULT false,
  metadata          JSONB DEFAULT '{}',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_showtimes_movie    ON showtimes (movie_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showtimes_cinema   ON showtimes (cinema_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showtimes_datetime ON showtimes (show_datetime) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showtimes_status   ON showtimes (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showtimes_org      ON showtimes (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_showtimes_screen   ON showtimes (screen_id) WHERE deleted_at IS NULL;


-- ============================================================================
-- 6. Movie Bookings
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_bookings (
  id                SERIAL PRIMARY KEY,
  booking_reference VARCHAR(20) UNIQUE NOT NULL,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  movie_id          INTEGER NOT NULL REFERENCES movies(id) ON DELETE RESTRICT,
  cinema_id         INTEGER NOT NULL REFERENCES cinemas(id) ON DELETE RESTRICT,
  cinema_screen_id  INTEGER NOT NULL REFERENCES cinema_screens(id) ON DELETE RESTRICT,
  showtime_id       INTEGER NOT NULL REFERENCES showtimes(id) ON DELETE RESTRICT,
  amount            INTEGER NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
  seat_count        INTEGER NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending_payment'
                     CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired', 'refunded', 'completed')),
  payment_status    VARCHAR(20) NOT NULL DEFAULT 'initiated'
                     CHECK (payment_status IN ('initiated', 'pending', 'captured', 'failed', 'refunded')),
  idempotency_key   VARCHAR(255) UNIQUE,
  hold_expires_at   TIMESTAMPTZ,
  metadata          JSONB DEFAULT '{}',
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movie_bookings_user        ON movie_bookings (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movie_bookings_showtime    ON movie_bookings (showtime_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movie_bookings_status      ON movie_bookings (status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_movie_bookings_idempotency ON movie_bookings (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movie_bookings_org         ON movie_bookings (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_movie_bookings_hold_expires ON movie_bookings (hold_expires_at) WHERE status = 'pending_payment';
CREATE INDEX IF NOT EXISTS idx_movie_bookings_reference   ON movie_bookings (booking_reference);

-- Partial unique index: only one pending_payment per user+showtime
CREATE UNIQUE INDEX IF NOT EXISTS idx_movie_bookings_user_showtime_pending
  ON movie_bookings (user_id, showtime_id)
  WHERE deleted_at IS NULL AND status = 'pending_payment';


-- ============================================================================
-- 7. Movie Booking Items
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_booking_items (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES movie_bookings(id) ON DELETE CASCADE,
  showtime_id       INTEGER NOT NULL REFERENCES showtimes(id) ON DELETE RESTRICT,
  seat_id           INTEGER NOT NULL REFERENCES cinema_seats(id) ON DELETE RESTRICT,
  seat_label        VARCHAR(10) NOT NULL,
  row_label         VARCHAR(5) NOT NULL,
  seat_number       INTEGER NOT NULL,
  seat_type         VARCHAR(20) NOT NULL DEFAULT 'standard',
  seat_category     VARCHAR(20) NOT NULL DEFAULT 'regular',
  price             INTEGER NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movie_booking_items_booking ON movie_booking_items (booking_id);
CREATE INDEX IF NOT EXISTS idx_movie_booking_items_seat   ON movie_booking_items (seat_id);
CREATE INDEX IF NOT EXISTS idx_movie_booking_items_showtime ON movie_booking_items (showtime_id);

-- Prevent double-booking of the same seat+showtime via active bookings
-- NOTE: The valid partial unique index is created in migration 038 using a
-- denormalized booking_status column (PostgreSQL does not allow subqueries
-- in partial index predicates, so the cross-table check must be deferred).


-- ============================================================================
-- 8. Movie Tickets
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_tickets (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES movie_bookings(id) ON DELETE CASCADE,
  booking_item_id   INTEGER NOT NULL REFERENCES movie_booking_items(id) ON DELETE CASCADE,
  ticket_uuid       VARCHAR(64) UNIQUE NOT NULL,
  showtime_id       INTEGER NOT NULL REFERENCES showtimes(id) ON DELETE RESTRICT,
  seat_label        VARCHAR(10) NOT NULL,
  row_label         VARCHAR(5) NOT NULL,
  seat_number       INTEGER NOT NULL,
  seat_type         VARCHAR(20) NOT NULL DEFAULT 'standard',
  qr_data           TEXT NOT NULL,
  signature         VARCHAR(128) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'valid'
                     CHECK (status IN ('valid', 'used', 'revoked', 'expired')),
  used_at           TIMESTAMPTZ,
  used_by           INTEGER REFERENCES admins(id),
  revoked_at        TIMESTAMPTZ,
  revoked_by        INTEGER REFERENCES admins(id),
  revoked_reason    TEXT,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movie_tickets_booking   ON movie_tickets (booking_id);
CREATE INDEX IF NOT EXISTS idx_movie_tickets_uuid      ON movie_tickets (ticket_uuid);
CREATE INDEX IF NOT EXISTS idx_movie_tickets_showtime  ON movie_tickets (showtime_id);
CREATE INDEX IF NOT EXISTS idx_movie_tickets_status    ON movie_tickets (status);


-- ============================================================================
-- 9. Movie Price Caps  (configurable, e.g., Tamil Nadu govt price caps)
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_price_caps (
  id                SERIAL PRIMARY KEY,
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  city              VARCHAR(100) NOT NULL,
  state             VARCHAR(100) NOT NULL,
  max_price_paise   INTEGER,
  currency          VARCHAR(3) NOT NULL DEFAULT 'INR',
  applies_to        VARCHAR(50) DEFAULT 'all'
                     CHECK (applies_to IN ('all', 'standard', 'premium', 'sofa')),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, city, state, applies_to)
);

CREATE INDEX IF NOT EXISTS idx_movie_price_caps_active ON movie_price_caps (organization_id, city, state) WHERE is_active = true;


-- ============================================================================
-- 10. Movie Booking Audits
-- ============================================================================

CREATE TABLE IF NOT EXISTS movie_booking_audits (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES movie_bookings(id) ON DELETE CASCADE,
  ticket_id         INTEGER REFERENCES movie_tickets(id) ON DELETE SET NULL,
  actor_type        VARCHAR(20) NOT NULL DEFAULT 'user'
                     CHECK (actor_type IN ('user', 'admin', 'system', 'worker')),
  actor_id          INTEGER,
  action            VARCHAR(50) NOT NULL,
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movie_booking_audits_booking ON movie_booking_audits (booking_id);
CREATE INDEX IF NOT EXISTS idx_movie_booking_audits_created  ON movie_booking_audits (created_at DESC);


-- ============================================================================
-- Timestamp triggers
-- ============================================================================

CREATE OR REPLACE FUNCTION update_movie_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movies_timestamp          ON movies;
DROP TRIGGER IF EXISTS trg_cinemas_timestamp          ON cinemas;
DROP TRIGGER IF EXISTS trg_cinema_screens_timestamp   ON cinema_screens;
DROP TRIGGER IF EXISTS trg_cinema_seats_timestamp     ON cinema_seats;
DROP TRIGGER IF EXISTS trg_showtimes_timestamp        ON showtimes;
DROP TRIGGER IF EXISTS trg_movie_bookings_timestamp   ON movie_bookings;
DROP TRIGGER IF EXISTS trg_movie_tickets_timestamp     ON movie_tickets;
DROP TRIGGER IF EXISTS trg_movie_price_caps_timestamp  ON movie_price_caps;

CREATE TRIGGER trg_movies_timestamp           BEFORE UPDATE ON movies           FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_cinemas_timestamp           BEFORE UPDATE ON cinemas           FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_cinema_screens_timestamp    BEFORE UPDATE ON cinema_screens    FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_cinema_seats_timestamp      BEFORE UPDATE ON cinema_seats      FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_showtimes_timestamp         BEFORE UPDATE ON showtimes         FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_movie_bookings_timestamp    BEFORE UPDATE ON movie_bookings    FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_movie_tickets_timestamp      BEFORE UPDATE ON movie_tickets     FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();
CREATE TRIGGER trg_movie_price_caps_timestamp   BEFORE UPDATE ON movie_price_caps  FOR EACH ROW EXECUTE FUNCTION update_movie_timestamp();


-- ============================================================================
-- ANALYZE
-- ============================================================================

ANALYZE movies;
ANALYZE cinemas;
ANALYZE cinema_screens;
ANALYZE cinema_seats;
ANALYZE showtimes;
ANALYZE movie_bookings;
ANALYZE movie_booking_items;
ANALYZE movie_tickets;
ANALYZE movie_price_caps;
ANALYZE movie_booking_audits;
