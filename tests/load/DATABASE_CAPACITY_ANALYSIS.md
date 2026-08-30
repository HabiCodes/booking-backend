# Movie Booking Database — Capacity Analysis

**Status:** Analysis based on schema review and query plan inspection. **NOT MEASURED** values require actual EXPLAIN ANALYZE output from a production-grade database with realistic data volumes.

---

## Schema Inventory

**Total tables (movie domain):** 10

| Table | Purpose | Estimated Rows @ 1000 shows/day |
|-------|---------|--------------------------------|
| `movies` | Movie catalog | ~500-2000 (low churn) |
| `cinemas` | Theatre locations | ~50-500 |
| `cinema_screens` | Screens per cinema | ~200-3000 |
| `cinema_seats` | Seats per screen | ~50,000-300,000 |
| `showtimes` | Per-movie-per-screen-per-time | ~5,000,000/year |
| `movie_bookings` | Customer bookings | ~500,000-2,000,000/year |
| `movie_booking_items` | Per-seat in a booking | ~2,500,000-10,000,000/year |
| `movie_tickets` | Issued tickets | ~1,500,000-6,000,000/year |
| `movie_price_caps` | State/government price caps | ~100-1000 |
| `movie_booking_audits` | Audit trail | ~5,000,000-20,000,000/year |

---

## Critical Indexes (Verified from Migrations)

### Migration 033 (`migrations/versions/033_movie_domain.sql`)

**Movies:**
- `idx_movies_status` — `(status) WHERE deleted_at IS NULL` — supports `WHERE status='now_showing' AND deleted_at IS NULL`
- `idx_movies_release_date` — `(release_date) WHERE deleted_at IS NULL` — supports date filters
- `idx_movies_organization` — `(organization_id) WHERE deleted_at IS NULL`
- `idx_movies_language` — `(language) WHERE deleted_at IS NULL`
- `idx_movies_slug` — `(slug)` — UNIQUE implicitly indexed
- `idx_movies_gin_genre` — GIN on `genre` array — supports `WHERE genre @> ARRAY[...]` search

**Showtimes:**
- `idx_showtimes_movie` — `(movie_id) WHERE deleted_at IS NULL` — supports `WHERE movie_id=$1`
- `idx_showtimes_cinema` — `(cinema_id) WHERE deleted_at IS NULL`
- `idx_showtimes_datetime` — `(show_datetime) WHERE deleted_at IS NULL` — supports date range queries
- `idx_showtimes_status` — `(status) WHERE deleted_at IS NULL` — supports `WHERE status='on_sale'`
- `idx_showtimes_screen` — `(screen_id) WHERE deleted_at IS NULL`

**Movie Bookings:**
- `idx_movie_bookings_user` — `(user_id) WHERE deleted_at IS NULL` — supports `listMyBookings`
- `idx_movie_bookings_showtime` — `(showtime_id) WHERE deleted_at IS NULL`
- `idx_movie_bookings_status` — `(status, deleted_at)` — supports cleanup workers
- `idx_movie_bookings_idempotency` — `(idempotency_key) WHERE idempotency_key IS NOT NULL` — supports idempotency lookups
- `idx_movie_bookings_hold_expires` — `(hold_expires_at) WHERE status = 'pending_payment'` — supports expiry worker
- **CRITICAL**: `idx_movie_bookings_user_showtime_pending` — UNIQUE partial index on `(user_id, showtime_id) WHERE deleted_at IS NULL AND status = 'pending_payment'` — enforces one pending booking per user per showtime

**Movie Booking Items:**
- `idx_movie_booking_items_booking` — `(booking_id)`
- `idx_movie_booking_items_seat` — `(seat_id)`
- `idx_movie_booking_items_showtime` — `(showtime_id)` — supports `findByShowtime` query in seat layout

### Migration 038 (`migrations/versions/038_fix_movie_booking_index.sql`)

**THE CRITICAL SAFETY INDEX:**
```sql
CREATE UNIQUE INDEX idx_movie_booking_items_seat_showtime_active
  ON movie_booking_items (seat_id, showtime_id)
  WHERE booking_status IN ('pending_payment', 'confirmed');
```

This is the DB-level guarantee that no seat can be double-booked. Even if Redis Lua fails, the INSERT will be rejected with a unique constraint violation.

Trigger functions (`sync_movie_booking_item_status_on_insert/update`) sync `booking_status` from `movie_bookings.status` so the partial index stays consistent.

---

## Query-by-Query Analysis

### Q1: `GET /api/v1/movies` (list movies)

**Query:**
```sql
SELECT * FROM movies
WHERE deleted_at IS NULL AND status = $1
ORDER BY release_date DESC LIMIT $2 OFFSET $3;
```

**Index used:** `idx_movies_status` (filter) + `idx_movies_release_date` (sort)

**Estimated cost:** Very low — partial index on status, sorted by date.

**Concern:** At 5000+ movies, pagination via LIMIT/OFFSET becomes slow on deep pages. Consider cursor-based pagination for `>page 100`.

**Status:** Code-verified. Actual `EXPLAIN ANALYZE` not measured.

---

### Q2: `GET /api/v1/showtimes/:id/seats` (seat layout)

**Queries (per request, from `getSeatLayout()`):**

1. Showtime metadata:
```sql
SELECT s.*, sc.seat_capacity, c.name as cinema_name
FROM showtimes s
JOIN cinema_screens sc ON s.screen_id = sc.id
JOIN cinemas c ON s.cinema_id = c.id
WHERE s.id = $1 AND s.deleted_at IS NULL;
```
**Index used:** PK on `showtimes(id)` — single-row lookup. Very fast.

2. Seats:
```sql
SELECT id, row_label, seat_number, seat_type, seat_category
FROM cinema_seats
WHERE screen_id = $1 AND is_available = true
ORDER BY row_label, seat_number;
```
**Index used:** `idx_cinema_seats_screen` partial index. For a 12×12 screen (144 seats), this returns 144 rows — minimal cost.

3. Booked seats (cross-table):
```sql
SELECT seat_id FROM movie_booking_items
WHERE showtime_id = $1 AND booking_status IN ('pending_payment', 'confirmed');
```
**Index used:** `idx_movie_booking_items_showtime` — but filter on `booking_status` is a sequential scan over the index result.

**Concern:** At high-volume showtimes (e.g., 10,000+ booking items per showtime), the index-only scan returns 10,000 rows. Consider adding `(showtime_id, booking_status)` composite index.

**Proposed optimization (NOT applied — speculative):**
```sql
CREATE INDEX idx_movie_booking_items_showtime_status
  ON movie_booking_items (showtime_id, booking_status);
```

4. Redis: `SMEMBERS hold:{showtime_id}` — typically small set (a few hundred held seats during peak)

5. Price caps (optional):
```sql
SELECT max_price_paise FROM movie_price_caps
WHERE is_active = true AND city = $1 AND state = $2
LIMIT 1;
```
**Index used:** `idx_movie_price_caps_active` on `(organization_id, city, state) WHERE is_active = true`

**Total query cost:** ~5-15ms with proper indexes on a normal showtime. Acceptable.

---

### Q3: `POST /api/v1/hold-seats` (atomic seat hold)

**Critical path:**
1. Showtime validation:
```sql
SELECT * FROM showtimes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE;
```
**Index used:** PK. The `FOR UPDATE` serializes this row.

2. User idempotency check (Redis): `EXISTS idempotency:hold:{user_id}:{showtime_id}`

3. Pre-check existing holds (PostgreSQL):
```sql
SELECT id FROM movie_booking_items
WHERE showtime_id = $1 AND seat_id = ANY($2::int[])
  AND booking_status IN ('pending_payment', 'confirmed');
```
**Index used:** `idx_movie_booking_items_showtime` + filter — OK for small numbers of seats.

4. **Atomic Lua script** (`SEAT_HOLD_LUA`) in Redis:
```lua
for each seat:
  SET hold:{showtime_id}:{seat_id} {holdKey} NX EX 600
  if NX failed: SADD conflict_set conflicted_seat
  else: SADD holds:{showtime_id} seat_id
```

This is the **primary concurrency gate**. Per-seat SET NX is atomic.

**Database write:** None at hold time. The hold exists only in Redis until the booking is created.

**Cost:** Very low. ~2-5ms typical.

---

### Q4: `POST /api/v1/bookings` (booking creation)

**Critical path:**
1. Idempotency key check (Redis): `SET idempotency:create:{user_id}:{idempotencyKey} NX EX 86400`

2. Atomic Lua: `GETDEL hold:{showtime_id}:{seat_id}` for each seat — atomically retrieves and deletes

3. PostgreSQL transaction:
```sql
BEGIN;
  -- 3a. Lock the showtime row
  SELECT id FROM showtimes WHERE id = $1 FOR UPDATE;

  -- 3b. Re-check seat availability
  SELECT id, status, available_seats FROM showtimes WHERE id = $1;
  UPDATE showtimes SET available_seats = available_seats - $1 WHERE id = $2;

  -- 3c. Insert booking
  INSERT INTO movie_bookings (...) VALUES (...) RETURNING *;

  -- 3d. Bulk insert booking items
  INSERT INTO movie_booking_items (...) VALUES (...), (...), ...;

  -- 3e. Insert idempotency record
  INSERT INTO idempotency_keys (...) VALUES (...);
COMMIT;
```

**Critical index: `idx_movie_booking_items_seat_showtime_active`** — the unique partial index. If two bookings try to insert the same seat, one fails with `unique_violation`.

**Cost:** ~20-50ms typical, dominated by FOR UPDATE locking and bulk INSERT.

**Concern:** Under high concurrency (100+ simultaneous bookings for the same showtime), `FOR UPDATE` on the showtime row serializes all bookings for that showtime. This is correct but limits throughput.

**Mitigation:** The Redis Lua script prevents most concurrent attempts from reaching PostgreSQL — only winners of the Redis SET NX make it to the DB transaction. So the DB lock is the second-line defense.

---

### Q5: `POST /api/v1/bookings/:id/confirm` (payment confirmation)

**Critical path:**
1. Lock booking:
```sql
SELECT * FROM movie_bookings WHERE id = $1 AND user_id = $2 FOR UPDATE;
```

2. Terminal state check (in-memory).

3. Payment verification (external gateway call — slow, 200-1000ms).

4. Update booking status:
```sql
UPDATE movie_bookings SET status = 'confirmed', payment_status = 'captured' WHERE id = $1;
```

5. Bulk insert tickets:
```sql
INSERT INTO movie_tickets (...) VALUES (...), (...), ...;
```

**Index used:** `idx_movie_bookings_user` for the initial lookup.

**Cost:** ~250-1500ms, dominated by payment gateway call.

---

### Q6: Hold expiry worker

**Query:**
```sql
UPDATE movie_bookings SET status = 'expired'
WHERE id = ANY($1::int[]) AND status = 'pending_payment';
```

**Index used:** PK on `id` — efficient for batch updates.

For finding expired bookings:
```sql
SELECT id FROM movie_bookings
WHERE status = 'pending_payment' AND hold_expires_at < NOW()
LIMIT 100;
```
**Index used:** `idx_movie_bookings_hold_expires` — well-targeted.

**Cost:** Minimal. Worker runs periodically (default 60s).

---

## Connection Pool Sizing

**Configured:** `config.db.connectionLimit` = `DB_CONNECTION_LIMIT` env (default 20)

**Analysis:**
- Pool of 20 connections
- Per-request lifetime: ~10-100ms for reads, ~50-1500ms for booking/confirm
- 20 connections × (1000ms / 50ms) = ~400 read requests/second per pool
- Booking creation requires:
  - 1 FOR UPDATE on showtime (serializes all bookings for that showtime)
  - 1 INSERT on movie_bookings
  - N INSERTs on movie_booking_items (one per seat, batched)
  - 1 UPDATE on showtimes
- ~5-10 bookings/second per showtime before queue forms

**Limitation:** With 20 connections, the server can process ~10-20 concurrent bookings per showtime. Beyond that, requests queue.

**NOT MEASURED:** Actual connection pool saturation point at high load.

---

## Storage Estimates

**Per booking row:** ~600 bytes (movie_bookings) + ~120 bytes per item (movie_booking_items) + ~250 bytes per ticket (movie_tickets)

**At 100,000 bookings/month:**
- `movie_bookings`: ~60 MB/month → ~720 MB/year
- `movie_booking_items`: ~60 MB/month × 3 avg seats → ~2.2 GB/year
- `movie_tickets`: ~25 MB/month → ~300 MB/year

**At 1,000,000 bookings/month:**
- ~7.2 GB/year bookings
- ~22 GB/year items
- ~3 GB/year tickets
- **Total: ~32 GB/year** + indexes (~30% overhead) = ~42 GB/year

**Recommendation:** Plan for partition-by-month on `movie_booking_items` and `movie_tickets` when the volume exceeds 10M rows.

---

## Hot Path Bottlenecks

### 1. Showtime row lock (`FOR UPDATE`)

**Query:** `SELECT id FROM showtimes WHERE id = $1 FOR UPDATE` (in `createBookingFromSeats`)

**Effect:** All bookings for the same showtime serialize on this row.

**Throughput limit:** ~50-200 bookings/second per showtime (depending on tx duration).

**Mitigation strategies:**
- Shorten transaction by moving audit inserts outside the lock window
- Use advisory locks per seat instead of showtime row lock (more granular)

### 2. Cinema seats scan in seat layout

**Query:** `SELECT * FROM cinema_seats WHERE screen_id = $1 ORDER BY row_label, seat_number`

**Effect:** At 300+ VUs hitting the same seat layout endpoint, the same data is fetched repeatedly.

**Mitigation:** Add 5-10s Redis cache for seat layout (acceptable staleness for UX).

### 3. Booking items cross-table query

**Query:** `SELECT seat_id FROM movie_booking_items WHERE showtime_id = $1 AND booking_status IN (...)`

**Effect:** At sold-out shows, returns thousands of rows.

**Mitigation:** Composite index `(showtime_id, booking_status)`.

---

## Verdict

**Architectural soundness:** ✅ Solid. The schema has the critical safety net (partial unique index), proper FK constraints, and indexes for common queries.

**Capacity headroom:** UNKNOWN — depends on PostgreSQL version, hardware, and concurrent showtime count.

**Required infrastructure changes for >10K VUs:**
- Composite index `(showtime_id, booking_status)` on `movie_booking_items`
- Redis cache for seat layout (60s TTL)
- Read replica for discovery endpoints
- Connection pool > 20 (recommend 50-100 for high-traffic shows)

**NOT MEASURED:** Actual RPS, latency p95/p99, connection pool saturation, index-only scan percentages. These require:
1. Production-grade PostgreSQL (16+, 4 vCPU, 8GB RAM)
2. Realistic data volumes (≥1M booking items)
3. Production-grade Redis (7+, 2 vCPU, 4GB RAM)
4. Multi-instance server deployment (2-4 instances behind a load balancer)
5. Load test tools (k6, vegeta, or wrk)

When this infrastructure is available, run `EXPLAIN ANALYZE` on each of the Q1-Q6 queries above to populate the measured values.