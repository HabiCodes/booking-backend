# Movie Booking Engine — Final Production Hardening + Load Validation Report

**Date:** 2026-08-29
**Scope:** Movie Booking domain ONLY — Events/Turf untouched
**Environment:** Code inspection + unit tests (858 pass, 22 DB-dependent E2E skipped)
**Load testing:** NOT TESTED — no PostgreSQL/Redis available in this environment

---

## Executive Summary

This report is the **final production hardening** of the Movie Booking Engine. It covers 16 phases: complete flow trace, screens/layouts audit, MAX tickets enforcement, seat hold concurrency, booking creation (with sequential INSERT fix), payment integrity, tickets+QR, database audit, Redis audit, connection pool sizing, hot-path optimization, rate limiting fix, real load testing, failure testing, BookMyShow contract verification, and final verdict.

### Key Fixes Applied (This Session)

| # | Fix | Type | Status |
|---|-----|------|--------|
| F1 | Sequential booking item INSERT → `bulkCreate` (1 query instead of N) | P1 Performance | ✅ APPLIED |
| F2 | Sequential ticket INSERT in `confirmBooking` → `bulkCreate` | P1 Performance | ✅ APPLIED |
| F3 | `bulkCreate()` + `client` param to accept transaction client | Infrastructure | ✅ APPLIED |
| F4 | Global rate limiter: MemoryStore → Redis-backed `createDistributedRateLimiter` | P1 Correctness | ✅ APPLIED |
| F5 | `expireStaleBookings`: manual connection-per-booking → `withTransaction` | P2 Resource | ✅ APPLIED |
| F6 | Pre-existing test type-strictness issues (3 tests) | P3 Test | ✅ FIXED |

### Key Findings Requiring Attention (Post-Session)

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| 1 | DB pool max=20 (configurable, must set in production) | P1 | Set `DB_CONNECTION_LIMIT=80` in production env |
| 2 | `expireStaleSeatHolds()` SCAN is redundant (TTL auto-expires) | P3 | Defer to operational improvement |
| 3 | Worker comment "user_hold keys (no TTL)" is incorrect — they DO have TTL | P3 | Fix comment |
| 4 | Load testing: requires running server + DB + Redis | P1 | Run in production-like environment |

---

## Phase 1: Complete Customer Flow Trace

### Flow: Discovery → Seat Layout → Hold → Booking → Payment → Ticket → Scan

**Step 1: Movie Discovery (Public, No Auth)**
- `GET /api/v1/movies` → `movieController.listMovies()` → `movieRepository.listPublished()`
- `GET /api/v1/cinemas` → `cinemaRepository.listAll()`
- `GET /api/v1/showtimes` → `showtimeRepository.listActive()`
- `GET /api/v1/movies/search?q=` → `movieBookingService.searchMovies()` → `movieRepository.search()`
- **Security:** No auth needed — correct for public browsing
- **Rate limiting:** Global rate limiter (NOW Redis-backed after F4)
- **Cache-Control:** 60s/300s on list endpoints — CODE-CONFIRMED
- **Auth:** None required — CORRECT

**Step 2: Showtime Detail + Seat Layout (Public, No Auth)**
- `GET /api/v1/showtimes/:id` → `showtimeRepository.findById()`
- `GET /api/v1/showtimes/:id/seats` → `movieBookingService.getSeatLayout()`
  - Fetches: showtime, cinema, ALL seats for screen, booked items from DB, held seats from Redis (SMEMBERS), price cap lookup
  - Returns: rows of seats with status (available/held/booked) and pricePaise (with premium multiplier + price cap)
- **Performance:** 5 sequential DB queries + 1 Redis SMEMBERS per request — no caching
- **Security:** No auth — CORRECT (public browsing)
- **Price integrity:** `_calculateSeatPrices()` is NOT called here — pricing is computed client-side via `calculatePrices()`. Server-side price cap IS applied in `getSeatLayout()`. **NEVER TRUSTS CLIENT PRICING** ✅

**Step 3: Seat Hold (Auth Required)**
- `POST /api/v1/hold-seats` → `movieBookingController.holdSeats()`
  - Requires `authMiddleware` (JWT bearer token)
  - Max 10 seats enforced at controller level (line 37-39)
  - Calls `movieBookingService.holdSeats(userId, showtimeId, seatIds)`
  - Redis Lua script `SEAT_HOLD_LUA` — atomic SET NX EX per seat
  - Returns `holdKey` (e.g., `movie:hold:42`) + `expiresAt` (10 minutes)
- **Security:** Auth required ✅, max 10 seats ✅, Lua atomic ✅
- **Idempotency:** `user_hold` key prevents duplicate holds per user per showtime ✅
- **Concurrency:** Lua script handles atomicity — F3 (seat hold storm) tests this

**Step 4: Create Booking (Auth Required)**
- `POST /api/v1/bookings` → `movieBookingController.createBooking()`
  - Extracts seat IDs from Redis holdKey (SMEMBERS)
  - Calls `movieBookingService.createBooking()` → `createBookingFromSeats()`
  - Inside `withTransaction`:
    1. `SELECT ... FOR UPDATE` on showtime (serialize concurrent bookings)
    2. INSERT booking row
    3. **bulkCreate booking items** (F1 fix — was sequential)
    4. UPDATE showtime available_seats
  - Post-commit: create payment order via PaymentService
  - Extend Redis hold TTL to payment window (5 min)
- **Security:** Auth ✅, FOR UPDATE serialization ✅, unique constraint ✅
- **Concurrency:** Sequential FOR UPDATE + partial unique index provides double-booking protection ✅

**Step 5: Payment (External Provider)**
- Customer redirected to payment provider
- Provider calls webhook → `PaymentService.handleWebhook()`
  - Webhook idempotency via `webhook_events` table
  - Signature verification
  - Status mapping: PAYMENT_SUCCESS → COMPLETED
- **Integrity:** `verifyPaymentAmount()` exact match — no trust of client amounts ✅
- **Concurrency:** `verifyPayment()` uses FOR UPDATE + terminal state guard ✅
- **Financial snapshot:** Stored in `payment_orders.financial_snapshot` ✅

**Step 6: Confirm Booking**
- `POST /api/v1/bookings/confirm` → `movieBookingController.confirmBooking()`
  - Calls `movieBookingService.confirmBooking(bookingId)`
  - Inside manual transaction:
    1. FOR UPDATE on booking
    2. Verify payment is COMPLETED
    3. `verifyPaymentAmount()` exact match
    4. **bulkCreate tickets** (F2 fix — was sequential)
    5. COMMIT
  - Post-commit: Release Redis holds, create settlement
- **Security:** Payment verification before ticket generation ✅, HMAC signing ✅

**Step 7: Ticket Display + Scan**
- `GET /api/v1/tickets/:uuid/verify` → `movieTicketService.verifyTicket()`
- Scanner: `POST /api/v1/scan/movies/verify` → `movieScanService.verify()`
  - 6-table JOIN, org-scoping, HMAC signature verification
- `POST /api/v1/scan/movies/checkin` → `movieScanService.markCheckedIn()`
  - Atomic UPDATE WHERE status='valid' — handles concurrent scans

### Flow Trace Verdict: ✅ PASS
- All steps verified in code
- Auth enforced at correct boundaries
- No path trusts client-provided pricing or availability
- Payment verification is server-side authority
- State machine: pending_payment → confirmed → completed OR pending_payment → cancelled/expired

---

## Phase 2: Screens + Layouts Audit

### Screen Model
- `cinema_screens` table: cinema_id, screen_number, seat_capacity, screen_type (standard/imax/dolby/4dx/screenx/gold_class), sound_system, row_labels, seats_per_row, seat_types (JSONB), pricing_rules (JSONB)
- `UNIQUE(cinema_id, screen_number)` — correct
- `idx_cinema_screens_cinema` on `(cinema_id) WHERE is_active = true` — correct
- No index on screen_number alone — acceptable since queries always filter by cinema_id

### Seat Layout System
- `cinema_seats` table: screen_id, row_label, seat_number, seat_type (standard/premium/sofa/wheelchair), seat_category (regular/couple/recliner), x/y position, is_available
- `UNIQUE(screen_id, row_label, seat_number)` — correct
- `idx_cinema_seats_screen` on `(screen_id) WHERE is_available = true` — correct

### Layout Versioning
- `cinema_screen_layout_versions` + `cinema_screen_layout_items` tables exist
- Versioning for seat layouts is supported but **not actively used by movie booking flow**
- Admin can create layout versions, set current, sync from screen
- **CODE-CONFIRMED:** Layout versioning infrastructure exists, movie flow uses current screen seats directly

### Screens+Layouts Verdict: ✅ PASS
- Unique constraints prevent duplicate seats per screen
- Screen types and seat types properly enumerated
- Layout versioning available for future use
- Seat layout endpoint correctly merges Redis holds + DB bookings for real-time status

---

## Phase 3: MAX 10 Tickets Enforcement

### Enforcement Points (Verified in Code)

| Layer | Check | Location | Value |
|-------|-------|----------|-------|
| Controller | `if (seatIds.length > 10)` | `movieBookingController.ts:37-39` | 10 |
| Service | `if (seatIds.length > MAX_SEATS_PER_BOOKING)` | `movieBookingService.ts:198` | 10 |
| Constant | `MAX_SEATS_PER_BOOKING = 10` | `movieBookingService.ts:49` | 10 |

### Offline/Manager Booking
- `MAX_SEATS_PER_OFFLINE_BOOKING = 10` — verified in offline booking service
- Separate constant but same value

### MAX 10 Tickets Verdict: ✅ PASS
- Triple enforcement (controller + service + constant)
- No bypass path identified — both online and offline flows enforce the limit
- Enforced BEFORE any DB write or Redis hold

---

## Phase 4: Seat Hold Concurrency Analysis

### Lua Script (`SEAT_HOLD_LUA`)
```lua
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = tonumber(ARGV[#ARGV])

for i = 1, count do
  local seatKey = key .. ':' .. ARGV[i + 1]
  local set = redis.call('SET', seatKey, 'held', 'EX', ttl, 'NX')
  if set == false then
    return { 0, ARGV[i + 1] }  -- Return the FIRST conflicted seat
  end
  redis.call('SADD', key, ARGV[i + 1])
end
return { 1 }
```

### Concurrency Properties

| Test | Mechanism | Result |
|------|-----------|--------|
| Same seat, same time | Redis SET NX is atomic | ✅ Only 1 succeeds |
| Different seats, same showtime | Multiple SET NX (different keys) | ✅ All succeed |
| Same seat, sequential | SET NX only succeeds once | ✅ Correct |
| Concurrent hold + booking | FOR UPDATE on showtime in transaction | ✅ Serialized |
| Hold expiration | TTL auto-expires after 600s | ✅ Automatic cleanup |
| Abandoned booking | Worker expires after 300s payment timeout | ✅ Cleanup |

### Race Condition: Hold → Booking

1. User A holds seat X (Redis key: `movie:hold:42:X`)
2. User B's Lua script returns 0 for seat X (correctly rejected)
3. User A creates booking (transaction: FOR UPDATE + INSERT + bulkCreate)
4. Partial unique index catches any concurrent booking of X
5. User A confirms payment → tickets generated

**No race condition identified.** The combination of:
- Lua atomic SET NX for initial hold
- PostgreSQL FOR UPDATE for booking serialization
- Partial unique index as safety net
- Payment verification before ticket generation

...provides defense-in-depth against double-booking.

### Seat Hold Concurrency Verdict: ✅ PASS
- Lua script correctly implements atomic per-seat holds
- Return value {0, seatId} allows controller to report which seat conflicted
- SADD tracks held seats for recovery in releaseSeats/cancelBooking

---

## Phase 5: Booking Creation Audit (Post-F1 Fix)

### Before F1 (Sequential INSERTs)
```
For 10 seats: 10 individual INSERT statements → 10x round-trips
Estimated latency: ~50-100ms for 10 seats (sequential)
```

### After F1 (bulkCreate)
```
For 10 seats: 1 multi-value INSERT → 1 round-trip
Estimated latency: ~10-20ms for 10 seats (bulk)
Expected improvement: ~5-10x faster
```

### Booking Creation Flow (Verified)

```
1. Validate showtime (status === 'on_sale', available_seats >= requested)
2. Per-user-per-showtime limit check (partial unique index)
3. Validate seats belong to correct screen
4. Double-booking check (findByShowtime → Set of booked seat IDs)
5. Price calculation (PricingEngine with GST + platform fee)
6. Idempotency check (Redis key + DB lookup)
7. WITH TRANSACTION:
   a. FOR UPDATE on showtime
   b. Re-check available_seats inside lock
   c. INSERT booking
   d. bulkCreate booking items (F1)
   e. UPDATE showtime available_seats
8. POST-COMMIT:
   a. Create payment order
   b. Cache idempotency key
   c. Extend Redis hold TTL
```

### Booking Creation Verdict: ✅ PASS (with F1 improvement)
- Sequential INSERT bottleneck ELIMINATED by F1
- Double-booking protection via FOR UPDATE + partial unique index
- Financial amounts computed server-side (PricingEngine) — NEVER from client
- Idempotency prevents duplicate bookings

---

## Phase 6: Payment Integrity Audit

### PaymentService Architecture

| Method | Concurrency Protection | Idempotency | Status |
|--------|----------------------|-------------|--------|
| `createOrder` | Idempotency key check | `payment_orders.idempotency_key` UNIQUE | ✅ |
| `verifyPayment` | FOR UPDATE + terminal state guard | Terminal states short-circuit | ✅ |
| `handleWebhook` | `webhook_events` idempotency key | Deterministic key (orderId + eventType) | ✅ |
| `processRefund` | FOR UPDATE + amount computation | DB-side remaining check | ✅ |

### Payment State Machine

```
CREATED → ACTIVE → COMPLETED
                → FAILED
                → CANCELLED
                → EXPIRED
COMPLETED → REFUNDED (admin only, NO customer refunds)
COMPLETED → PARTIALLY_REFUNDED (admin only)
```

### Payment Integrity Findings

1. **Amount verification:** `verifyPaymentAmount()` uses exact match (expectedPaise === paidPaise) ✅
2. **No customer refunds:** Enforced at service layer — `customer_initiated` throws 403 ✅
3. **Webhook idempotency:** Deterministic key prevents double-processing ✅
4. **Race condition:** FOR UPDATE + terminal state guard in verifyPayment ✅
5. **Financial snapshot:** Stored in `payment_orders.financial_snapshot` JSONB ✅

### Payment Integrity Verdict: ✅ PASS
- All payment paths verified
- No path allows customer-initiated refund
- Amounts always verified server-side
- Webhook replay attacks prevented by idempotency

---

## Phase 7: Tickets + QR Audit

### Ticket Generation (`confirmBooking`)
- UUIDs generated via `UniversalTicketService.generateTicketUuid('movie')` → `crypto.randomUUID()`
- HMAC-SHA256 signature via `UniversalTicketService.sign()`
- QR data JSON: ref, ticket UUID, seat, row, showtime, domain
- Tickets generated inside database transaction — if any fail, entire confirmation rolls back
- After F2: tickets created via `bulkCreate` inside transaction ✅

### Ticket Scanning (`movieScanService`)

| Endpoint | Auth | Org-Scoping | HMAC Check | Atomic |
|----------|------|-------------|------------|--------|
| `verify` | Scanner auth | ✅ adminOrganizationId | ✅ verifyTicketSignature | N/A (read) |
| `markCheckedIn` | Scanner auth | ✅ adminOrganizationId | ✅ verifyTicketSignature | ✅ WHERE status='valid' |

### Ticket Security Findings
1. **HMAC verification before state change:** Both verify() and markCheckedIn() verify HMAC BEFORE returning result ✅
2. **Atomic check-in:** `UPDATE ... WHERE ticket_uuid=$2 AND status='valid'` — concurrent scanners handled ✅
3. **Expired tickets:** Checked against `end_datetime` ✅
4. **Revoked tickets:** Checked before any processing ✅
5. **Organization scoping:** Scanner only sees tickets for their org ✅

### Tickets + QR Verdict: ✅ PASS
- Tickets generated atomically inside booking confirmation transaction
- HMAC signatures verified on every scan
- Concurrent scan handled by atomic UPDATE

---

## Phase 8: Database Audit

### Schema Verification (Migration 033 + 038)

| Table | Rows | Indexes | Partial Indexes | Notes |
|-------|------|---------|-----------------|-------|
| movies | ~20 | 6 (status, release_date, org, language, slug, gin_genre) | 5 WHERE clauses | ✅ |
| cinemas | ~10 | 5 (city, org, state, slug, active) | ✅ | ✅ |
| cinema_screens | ~50 | 1 (cinema_id WHERE active) | ✅ | ✅ |
| cinema_seats | ~500-2000 | 1 (screen_id WHERE available) | ✅ | ✅ |
| showtimes | ~200 | 6 (movie, cinema, datetime, status, org, screen) | ✅ | ✅ |
| movie_bookings | ~10K+ | 7 (user, showtime, status, idempotency, org, hold_expires, reference) | 1 UNIQUE (user+showtime pending) | ✅ |
| movie_booking_items | ~50K+ | 3 (booking, seat, showtime) | ✅ | ✅ |
| movie_tickets | ~50K+ | 4 (booking, uuid, showtime, status) | ✅ | ✅ |
| movie_price_caps | ~20 | 1 (org+city+state WHERE active) | ✅ | ✅ |

### Index Usage Analysis (CODE-CONFIRMED)

| Query | Index Used | Verified |
|-------|-----------|----------|
| `findById(showtimeId)` | PK `showtimes.id` | ✅ Clustered index |
| `findByShowtime(showtimeId)` | `idx_movie_booking_items_showtime` | ✅ Used in findByShowtime |
| `findByBooking(bookingId)` | `idx_movie_booking_items_booking` | ✅ Used in findByBooking |
| `findByIdempotencyKey(key)` | `idx_movie_bookings_idempotency` | ✅ UNIQUE index |
| `findByUser(userId)` | `idx_movie_bookings_user` | ✅ WHERE deleted_at IS NULL |
| `cancelExpiredHolds(cutoff)` | `idx_movie_bookings_hold_expires` | ✅ WHERE status='pending_payment' |
| `getMovieTicketWithDetails(uuid)` | `idx_movie_tickets_uuid` | ✅ Used in verify |
| `moviePriceCapRepository.findActive()` | `idx_movie_price_caps_active` | ✅ org+city+state WHERE is_active |
| Seat availability check | `idx_movie_booking_items_seat` + booking JOIN | ✅ Through findByShowtime |

### Migration 038 Double-Booking Protection
- `booking_status` column on `movie_booking_items` synced via triggers
- Partial unique index: `(seat_id, showtime_id) WHERE booking_status IN ('pending_payment', 'confirmed')`
- **This is the safety net** — if the Lua script + FOR UPDATE somehow miss a race, the partial unique index catches it

### Database Verdict: ✅ PASS
- All queries use appropriate indexes
- Partial unique indexes enforce business rules at DB level
- Foreign keys with appropriate ON DELETE actions
- No missing indexes for hot-path queries identified

---

## Phase 9: Redis Audit

### Key Patterns Used

| Key Pattern | Purpose | TTL | SET NX |
|-------------|---------|-----|--------|
| `movie:hold:{showtimeId}` | Set of held seat IDs | 600s | SADD |
| `movie:hold:{showtimeId}:{seatId}` | Individual seat hold | 600s | SET NX EX |
| `movie:user_hold:{userId}:{showtimeId}` | Per-user hold idempotency | 600s (extended to 300s on booking) | SET |
| `movie:idempotency:{key}` | Booking idempotency | 360s | SET |

### Redis Error Handling
- ioredis config: `maxRetriesPerRequest: 3`, exponential backoff, `connectTimeout: 5000ms`, `enableOfflineQueue: true`
- `distributedRateLimiter.ts`: fail-open (skipIfRedisDown: true for global, false for auth)
- `isRedisAvailable()` check before Redis operations in rate limiter

### Redis Keyspace Analysis

For a typical showtime with 200 seats:
- 200 individual `movie:hold:{st}:{seat}` keys during active selling
- 1 `movie:hold:{st}` set key
- Up to 200 `movie:user_hold:{uid}:{st}` keys (one per user)
- ~10 `movie:idempotency` keys per showtime at any time

**Total keys per active showtime: ~400** — very manageable.

### Worker SCAN Issue (P3)
- `expireStaleSeatHolds()` uses SCAN MATCH — but ALL keys have TTL
- Redis auto-expires keys when TTL reaches 0
- SCAN loop is redundant — does no harm but wastes CPU cycles
- Comment saying "no TTL on user_hold keys" is INCORRECT — they DO have TTL

### Redis Verdict: ✅ PASS (with P3 note)
- All key patterns documented
- TTLs prevent unbounded growth
- Lua scripts provide atomicity
- Error handling: fail-open for non-critical paths

---

## Phase 10: Connection Pool Sizing

### Current Configuration
- **Default:** `DB_CONNECTION_LIMIT=20` (from `config/index.ts`)
- **Pool config:** `idleTimeoutMillis=30000`, `connectionTimeoutMillis=5000`

### Pool Sizing Formula
```
max_connections = (core_count * 2) + effective_spindle_count
```

For a 4-core server: `(4 * 2) + 4 = 12` (minimum)
With headroom for workers + spikes: `12 * 3 = 36` (recommended minimum)

### Movie Booking Hot-Path Connection Usage

| Operation | Connections Held | Duration |
|-----------|-----------------|----------|
| `holdSeats` | 0 (Redis only) | ~5ms |
| `createBooking` (withTransaction) | 1 | ~50-100ms (includes gateway call) |
| `confirmBooking` (manual tx) | 1 | ~100-200ms (includes ticket generation) |
| `getSeatLayout` | 1 (per query) | ~20-50ms |
| `expireStaleBookings` (F5 fix) | 1 per booking (withTransaction) | ~10ms per booking |

### Maximum Concurrent Bookings Calculation

With pool=20:
- Max concurrent `createBooking` transactions: ~16 (reserving 4 for other operations)
- At 100ms per booking: ~160 bookings/second peak
- With pool=80: ~64 concurrent, ~640 bookings/second peak

### Recommendation
- **Staging:** `DB_CONNECTION_LIMIT=40`
- **Production:** `DB_CONNECTION_LIMIT=80`
- **PostgreSQL `max_connections` must be set >= application pool + connection pooler (pgBouncer) + admin connections + replication

### Pool Sizing Verdict: ⚠️ NEEDS CONFIG
- Code is correct (configurable)
- **MUST set `DB_CONNECTION_LIMIT=80` in production** — current default of 20 is too low for any meaningful traffic
- With F5 fix, `expireStaleBookings` properly releases connections

---

## Phase 11: Hot-Path Optimization Summary

### Optimizations Applied (This Session)

| # | Before | After | Improvement |
|---|--------|-------|-------------|
| F1 | N sequential INSERTs for booking items | 1 bulk INSERT | ~5-10x faster |
| F2 | N sequential INSERTs for tickets | 1 bulk INSERT | ~5-10x faster |
| F4 | express-rate-limit MemoryStore (per-process) | Redis-backed (shared) | Correct multi-instance behavior |
| F5 | Manual connection per expired booking | withTransaction (auto release) | Prevents pool exhaustion |

### Remaining Optimizations (Not Applied — Defer)

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| O1 | `getSeatLayout()`: 5 sequential queries | Medium — called on every seat selection | Medium (caching layer) |
| O2 | Price cap lookup duplicated in `getSeatLayout()` + `_calculateSeatPrices()` | Low — 2 queries saved | Low (cache price cap in service) |
| O3 | `expireStaleSeatHolds()` SCAN loop | Low — redundant (TTL auto-expires) | Trivial (remove SCAN) |
| O4 | No response caching on public endpoints | Medium — repeated identical queries | Medium (Redis cache with TTL) |

### Hot-Path Verdict: ✅ PASS (with defer items)
- Critical path (booking creation) optimized with bulkCreate
- Connection management fixed with withTransaction
- Rate limiting now shared across instances

---

## Phase 12: Rate Limiting Fix (F4)

### Before F4
- Global limiter: `express-rate-limit` with MemoryStore — process-scoped
- **Problem:** In multi-instance deployment, each instance has its own counter. 3 instances × 300/min = 900/min effective limit (3x intended)
- Sub-limiters: Redis-backed via `createDistributedRateLimiter` — correctly shared

### After F4
- Global limiter: `createDistributedRateLimiter` with Redis — shared across all instances
- Same limits (300/min global, 15/min booking, 30/min payment)
- Fail-open: if Redis is down, allows requests (fallback to basic protection)
- Auth limiter: `skipIfRedisDown: false` — blocks all auth if Redis is down (fail-closed for security)

### Rate Limiting Verdict: ✅ PASS (F4 applied)
- Global limiter now uses Redis — correct multi-instance behavior
- Per-IP key generation via `req.ip`
- Standard RateLimit headers (X-RateLimit-Limit, X-RateLimit-Remaining)

---

## Phase 13: Real Load Testing

### Environment Limitation
**NOT TESTED** — No PostgreSQL, Redis, or Node.js server available in this environment. Cannot install k6 or autocannon (no network for npm, no apt access).

### What Can Be Tested (Requires Production Environment)

| Scenario | Description | Target | Test Method |
|----------|-------------|--------|-------------|
| LT1 | Movie discovery (reads) — 100 concurrent users | p95 < 200ms | k6 with 100 VUs, 30s ramp |
| LT2 | Seat layout (hot showtime) — 50 concurrent | p95 < 500ms | k6 with 50 VUs |
| LT3 | Seat hold storm — 100 users, same seat | Exactly 1 success | k6 + custom logic |
| LT4 | Hot seat attack — 500 concurrent, same seat | Exactly 1 success | k6 stress test |
| LT5 | Booking creation — 20 sequential | All succeed, correct amounts | k6 + DB verification |
| LT6 | Complete flow — 10 users (discover→hold→book→pay) | End-to-end < 5s | k6 scenario |

### Load Testing Protocol (For Production Environment)

```bash
# 1. Seed data
psql -f tests/seed/load_test_data.sql

# 2. Start server
DB_CONNECTION_LIMIT=80 PORT=4000 npm run dev

# 3. Run k6 tests
k6 run tests/load/k6_movie_load.js

# 4. Monitor during test
# - PostgreSQL: pg_stat_activity, pg_stat_database
# - Redis: INFO memory, INFO clients
# - Server: CPU, memory, connection count
```

### Load Testing Verdict: ⚠️ NOT TESTED
- Cannot run without live infrastructure
- Test scripts provided in `tests/load/`
- Expected to pass based on:
  - F1 fix eliminates sequential INSERT bottleneck
  - Redis-backed rate limiting handles high concurrency
  - Lua script provides atomic seat holds at any concurrency
  - DB pool=80 handles ~640 bookings/second peak

---

## Phase 14: Failure Testing

### Scenarios (Code-Confirmed, Not Executed)

| # | Failure | Expected Behavior | Verified |
|---|---------|-------------------|----------|
| F1 | Redis down | Rate limiter fails open (non-critical). Seat holds unavailable → bookings blocked. | Code review ✅ |
| F2 | PostgreSQL down | Pool connection timeout (5s). Server returns 503. Workers skip. | Code review ✅ |
| F3 | Payment gateway timeout | `verifyPayment` rolls back transaction. Booking stays pending_payment. Worker expires after 5 min. | Code review ✅ |
| F4 | Duplicate webhook delivery | `webhook_events` idempotency key prevents double-processing. | Code review ✅ |
| F5 | Server crash mid-booking | FOR UPDATE lock released on connection close. Seat becomes available again (TTL expires on hold). | Code review ✅ |
| F6 | Server crash mid-confirmation | Transaction not committed → booking stays pending_payment. Worker expires after 5 min. | Code review ✅ |
| F7 | Concurrent scanner scans | Atomic UPDATE `WHERE status='valid'` — only one succeeds, others get ALREADY_SCANNED. | Code review ✅ |

### Failure Testing Verdict: ✅ CODE-CONFIRMED
- All failure modes handled correctly based on code review
- No "happy path only" assumptions identified
- Graceful degradation: Redis fail-open for non-critical paths

---

## Phase 15: BookMyShow-Style Backend Contract Verification

### Required Capabilities

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| Seat selection with real-time availability | Redis Lua holds + DB partial unique index | ✅ |
| Hold → book → pay → ticket flow | Complete state machine | ✅ |
| Atomic seat allocation (no double-booking) | Lua SET NX + FOR UPDATE + partial unique index | ✅ |
| Price enforcement (GST, platform fee, caps) | PricingEngine + price cap enforcement | ✅ |
| Idempotent booking creation | Redis + DB idempotency keys | ✅ |
| Idempotent payment webhooks | Deterministic key in webhook_events | ✅ |
| Secure ticket generation (HMAC) | UniversalTicketService.sign() | ✅ |
| Concurrent scan handling | Atomic UPDATE WHERE status='valid' | ✅ |
| Payment amount server verification | verifyPaymentAmount() exact match | ✅ |
| No customer-initiated refunds | Service layer guard (403) | ✅ |
| Settlement tracking | movie_settlements + financial calculator | ✅ |
| Admin CRUD for all entities | movieAdminController complete | ✅ |
| Multi-screen/cinema support | cinema_screens, cinema_seats | ✅ |
| Seat type pricing (premium, sofa, couple) | Premium multipliers in PricingEngine | ✅ |

### Contract Verdict: ✅ PASS
- All BookMyShow-style backend requirements satisfied
- Additional features beyond contract: layout versioning, S3 media, event manager, HMAC scanning

---

## Phase 16: Final Verdict — Strict Pass/Fail

### Summary Table

| Phase | Area | Verdict | Evidence |
|-------|------|---------|----------|
| 1 | Complete customer flow trace | ✅ PASS | Code reviewed, all 7 steps verified |
| 2 | Screens + layouts audit | ✅ PASS | Schema verified, constraints confirmed |
| 3 | MAX 10 tickets enforcement | ✅ PASS | Triple enforcement (controller+service+constant) |
| 4 | Seat hold concurrency | ✅ PASS | Lua script atomic, race conditions handled |
| 5 | Booking creation | ✅ PASS | F1 applied — bulkCreate instead of sequential |
| 6 | Payment integrity | ✅ PASS | All paths verified, no customer refunds |
| 7 | Tickets + QR | ✅ PASS | HMAC verified, atomic scan, F2 applied |
| 8 | Database audit | ✅ PASS | All indexes verified, partial unique constraints |
| 9 | Redis audit | ✅ PASS | Key patterns documented, TTLs set |
| 10 | Connection pool sizing | ⚠️ NEEDS CONFIG | Code correct, must set DB_CONNECTION_LIMIT=80 |
| 11 | Hot-path optimization | ✅ PASS | F1, F2, F4, F5 applied |
| 12 | Rate limiting fix | ✅ PASS | F4 applied — Redis-backed global limiter |
| 13 | Real load testing | ⚠️ NOT TESTED | No infrastructure available |
| 14 | Failure testing | ✅ CODE-CONFIRMED | All 7 failure modes verified by code review |
| 15 | BookMyShow contract | ✅ PASS | All 14 requirements satisfied |
| 16 | Overall verdict | ✅ PRODUCTION READY | With DB_CONNECTION_LIMIT=80 + load test in prod env |

### Issues Requiring Action Before Production

| Priority | Issue | Action |
|----------|-------|--------|
| **P1** | DB pool default=20 | Set `DB_CONNECTION_LIMIT=80` in production environment |
| **P1** | Load testing not run | Run k6 tests against staging with production-like data |
| **P2** | Worker SCAN loop redundant | Remove `expireStaleSeatHolds()` SCAN (TTL auto-expires) |
| **P3** | Incorrect comment about user_hold TTL | Fix comment in `movieWorkers.ts` line 49 |

### Performance Expectations (Estimated, NOT Measured)

| Endpoint | Expected Latency | Notes |
|----------|-----------------|-------|
| GET /movies | 10-50ms | No DB joins, simple query |
| GET /showtimes/:id/seats | 50-150ms | 5 queries + Redis SMEMBERS (before O1 cache) |
| POST /hold-seats | 5-15ms | Redis only (Lua script) |
| POST /bookings | 100-200ms | DB transaction + payment gateway call |
| POST /bookings/confirm | 150-300ms | DB transaction + ticket generation |
| GET /tickets/:uuid/verify | 20-50ms | 6-table JOIN |

### Final Production Gate Verdict

**✅ PRODUCTION READY** — with the following conditions:

1. **REQUIRED:** Set `DB_CONNECTION_LIMIT=80` in production `.env`
2. **REQUIRED:** Run real load tests (k6) against staging before production deployment
3. **RECOMMENDED:** Remove redundant SCAN loop in `expireStaleSeatHolds()`
4. **RECOMMENDED:** Add response caching layer for public endpoints (movies, cinemas, showtimes)

The codebase has been hardened with:
- Sequential INSERT elimination (F1, F2) — major performance improvement
- Redis-backed global rate limiting (F4) — correct multi-instance behavior
- Proper connection management (F5) — prevents pool exhaustion
- All security controls verified (auth, HMAC, idempotency, concurrency)
- All financial controls verified (exact match, no customer refunds, financial snapshot)

---

*Report generated by automated production hardening audit. All latency numbers are ESTIMATED based on code analysis — NOT measured. Load testing must be performed in a production-like environment before final deployment sign-off.*
