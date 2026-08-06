-- 010_index_optimization.sql
-- Adds indexes for dashboard query patterns introduced in Phase 6.
-- Uses IF NOT EXISTS so this is safely idempotent on databases where some
-- of the underlying indexes may already exist.

-- ── Audit logs ───────────────────────────────────────────────────────────────
-- The audit viewer filters by action (ILIKE), entity_type, and entity_id, plus
-- the combined admin+time range. A composite index on (action) covers the ILIKE
-- scan; entity_type/entity_id is covered by the existing idx_audit_logs_entity.
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_trgm
  ON audit_logs (action text_pattern_ops);

-- ── Users ────────────────────────────────────────────────────────────────────
-- Dashboard users search ILIKE-matches email or username. A trgm-style index
-- would be ideal, but we can't assume pg_trgm is installed. The B-tree on
-- email (already exists) plus a covering index for created_at sort is enough
-- for the dashboard's listing.
CREATE INDEX IF NOT EXISTS idx_users_created_at_desc
  ON users (created_at DESC);

-- ── Bookings ────────────────────────────────────────────────────────────────
-- Dashboard orders bookings by created_at DESC and filters by status.
-- idx_bookings_event_status already covers event+status. Add created_at for
-- the dashboard sort.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at_desc
  ON bookings (created_at DESC);

-- Composite index to back the dashboard's `WHERE status = $1 ORDER BY
-- created_at DESC` query (used by /admin/bookings?status=...).
CREATE INDEX IF NOT EXISTS idx_bookings_status_created
  ON bookings (status, created_at DESC);

-- ── Tickets ─────────────────────────────────────────────────────────────
-- Recent tickets query orders by created_at DESC.
CREATE INDEX IF NOT EXISTS idx_tickets_created_at_desc
  ON tickets (created_at DESC);

-- Back the per-event check-in tally (LEFT JOIN tickets ON ... AND checked_in = true).
-- The existing idx_tickets_checked_in covers the boolean filter; a composite
-- (booking_id, checked_in) makes the join cheaper when aggregating per event.
CREATE INDEX IF NOT EXISTS idx_tickets_booking_checkedin
  ON tickets (booking_id, checked_in)
  WHERE checked_in = true;

-- ── Events ─────────────────────────────────────────────────────────────
-- Dashboard `events.breakdown` joins events → bookings → tickets. The
-- existing partial indexes are status/feature/date/city. Add an index on
-- `deleted_at IS NULL` lookups by capacity used in sort order? The existing
-- partial indexes already filter on deleted_at IS NULL, so no further
-- index is required here.

-- ── Login attempts ────────────────────────────────────────────────────
-- Login attempts are queried by IP for the rate limiter. Composite exists.
-- A partial index restricted to a rolling 24-hour window cannot be expressed
-- with NOW() in the predicate (NOW() is STABLE, not IMMUTABLE, and is
-- therefore rejected by PostgreSQL in index expressions).  Instead, use a
-- composite B-tree index on (ip_address, attempted_at DESC) — the planner
-- uses the leading column for the IP equality lookup and the descending
-- timestamp lets the rate-limiter walk only the most recent rows.  This
-- matches the same query pattern that the partial index was targeting,
-- without needing a volatile predicate.
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON login_attempts (ip_address, attempted_at DESC);

-- ── Admins ─────────────────────────────────────────────────────────────
-- The seed/login flow queries admins by email. idx_admins_email already
-- exists. Active-admin lookups (login guard) benefit from a partial index.
CREATE INDEX IF NOT EXISTS idx_admins_active
  ON admins (email)
  WHERE is_active = true;

-- ── Verification tokens ───────────────────────────────────────────────
-- Email verification lookup is by token_hash (already exists) but the
-- expunge-by-expires_at query benefits from a partial index of unrevoked
-- tokens.
CREATE INDEX IF NOT EXISTS idx_verification_tokens_unused
  ON verification_tokens (expires_at)
  WHERE used_at IS NULL;

-- ── ANALYZE ───────────────────────────────────────────────────────────
-- After index creation, refresh planner stats so subsequent queries pick
-- them up.
ANALYZE audit_logs;
ANALYZE users;
ANALYZE bookings;
ANALYZE tickets;
ANALYZE login_attempts;
ANALYZE admins;
ANALYZE verification_tokens;