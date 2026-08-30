# Movie Booking System — Capacity Test Documentation

**Purpose:** Define the exact methodology, infrastructure requirements, pass/fail criteria, and expected outcomes for each load and concurrency test.

**Constraint:** All numbers below represent **measured** results. Sections marked `NOT MEASURED` indicate tests that require specific infrastructure to execute. Do NOT claim results for tests that have not been run.

---

## Test Infrastructure Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| PostgreSQL | 16+ | 16+, 4 vCPU, 8GB RAM |
| Redis | 7+ | 7+, 2 vCPU, 4GB RAM |
| Node.js server | 22+ | 22+, 2 vCPU, 4GB RAM |
| Disk | SSD | NVMe SSD |

### Seed Data Requirements

The following must exist in the database before running tests:

- **Movies:** At least 5 active movies (`status='active'`, `is_active=true`)
- **Cinemas:** At least 3 cinemas across 2+ cities
- **Screens:** At least 2 screens per cinema (8×8 to 12×12 seats)
- **Showtimes:** At least 2 `on_sale` showtimes per movie, within the next 7 days
- **Seats:** 100+ available seats per showtime
- **Users:** At least 1 verified customer user (for auth-dependent tests)

### Environment Variables

```env
# Server
BASE_URL=http://localhost:4000
DATABASE_URL=postgres://user:pass@localhost:5432/booking_db
REDIS_URL=redis://localhost:6379
JWT_SECRET=<64+ char random hex>

# Test tokens (for k6 / Node.js load testers)
TEST_USER_TOKEN=<valid JWT for a real user in the DB>

# Target IDs (adjust to match seed data)
MOVIE_ID=1
CINEMA_ID=1
SHOWTIME_ID=1
SCREEN_ID=1
```

---

## Test Suite Overview

### Test 1: Movie Discovery (Read-Heavy Public Endpoints)

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `discovery`

**What it tests:**
- `GET /api/v1/movies` — list all movies
- `GET /api/v1/movies/:id` — single movie detail
- `GET /api/v1/cinemas` — list cinemas
- `GET /api/v1/showtimes` — list showtimes
- `GET /api/v1/movies/featured` — featured movies
- `GET /api/v1/movies/genres` — genre list
- `GET /api/v1/movies/search?q=action` — search
- `GET /api/v1/movies/languages` — language list

**Load profile:**
- Ramp: 50 → 200 VUs over 15s → hold 500 VUs for 45s → ramp down
- Total test duration: ~75s
- Expected requests per VU: ~50-100 (depending on think time)

**Pass criteria:**
- p95 latency < 500ms
- p99 latency < 1000ms
- Error rate < 1%
- No 5xx errors

**Expected bottleneck:** PostgreSQL sequential scans if indexes are missing on `movies.is_active`, `showtimes.status`, `showtimes.showtime_date`. With proper indexes, Redis is not involved (all reads go to PostgreSQL).

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=discovery
```

---

### Test 2: Hot Showtime Seat Map (Single-Showtime Read)

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `seatMap`

**What it tests:**
- `GET /api/v1/showtimes/:id/seats` — full seat layout with pricing

**Load profile:**
- Ramp: 50 → 300 VUs over 10s → hold 300 VUs for 30s → ramp down
- Total test duration: ~50s

**Queries per request (from `getSeatLayout`):**
1. `SELECT showtime, screen, cinema FROM showtimes WHERE id = $1`
2. `SELECT * FROM cinema_seats WHERE screen_id = $1 ORDER BY row_label, seat_number`
3. `SELECT seat_id FROM movie_booking_items WHERE showtime_id = $1 AND booking_status IN ('pending_payment', 'confirmed')`
4. `SELECT price FROM movie_price_caps WHERE showtime_id = $1` (optional)
5. Redis: `SMEMBERS hold:{showtime_id}`

**Pass criteria:**
- p95 latency < 500ms
- p99 latency < 1000ms
- Error rate < 1%

**Expected bottleneck:** The 3-query seat layout + Redis SMEMBERS. With 300 VUs × 30s = ~9000 requests, PostgreSQL should handle this with proper indexes on `movie_booking_items(showtime_id, booking_status)`.

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=seatMap
```

---

### Test 3: Seat Competition Stress (Atomic Concurrency)

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `seatCompetition`

**What it tests:**
- `POST /api/v1/hold-seats` — 200 users concurrently holding the SAME 5 seats

**Load profile:**
- Ramp: 20 → 200 VUs over 10s → hold 200 VUs for 30s → ramp down
- Total test duration: ~50s

**Critical assertions:**
- **Exactly 1 hold must succeed** for the same seat set
- All other requests must return 409 (Conflict)
- The Redis Lua script `SEAT_HOLD_LUA` uses `SET NX EX` per seat — this is the atomic gate
- The PostgreSQL partial unique index `idx_movie_booking_items_seat_showtime_active` is the DB-level safety net

**Pass criteria:**
- Exactly 1 success, rest are 409s
- Error rate < 1% (no 5xx, no unexpected status codes)
- Seat count in DB matches expected value after test

**What would indicate a bug:**
- >1 success: race condition in Lua script or missing index usage
- 0 successes: Lua script error or Redis unavailable
- 5xx errors: unhandled exception in hold path

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=seatCompetition
```

---

### Test 4: 10-Ticket Limit Enforcement

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `tenTicketLimit`

**What it tests:**
- Hold requests with 1, 5, 10 seats → must succeed (200/409)
- Hold requests with 11, 20 seats → must return 400 with message `Cannot hold more than 10 seats at once`

**Enforcement layers:**
1. **Controller** (`movieBookingController.ts` line ~37): `req.body.seatIds.length > MAX_SEATS_PER_BOOKING`
2. **Service** (`movieBookingService.ts` line ~124 and ~198): double check
3. **Config** (`config/index.ts`): `maxTicketsPerBooking: 10`

**Pass criteria:**
- Requests for ≤10 seats: status 200 or 409
- Requests for >10 seats: status 400 with correct error message
- 100% enforcement across all VUs

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=tenTicketLimit
```

---

### Test 5: Concurrent Booking Flow (Hold → Book)

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `bookingFlow`

**What it tests:**
- Full flow: hold seats → create booking → (mock) payment reference
- 100 VUs each creating unique bookings (different seat sets to minimize conflicts)

**Pass criteria:**
- p95 latency < 1000ms
- p99 latency < 2000ms
- Error rate < 5% (higher tolerance because conflicts are expected)
- No double-bookings in final DB state

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=bookingFlow
```

---

### Test 6: Mixed Realistic Traffic

**File:** `tests/load/movieBookingLoadTest.js` — Scenario `mixedTraffic`

**What it tests:**
- Realistic traffic distribution mirroring production:
  - 70% discovery (browsing)
  - 15% seat map (looking at specific showtime)
  - 8% seat hold (intent to buy)
  - 4% booking creation (conversion)
  - 2% search
  - 1% genre listing

**Load profile:**
- Ramp: 20 → 200 VUs over 15s → hold 300 VUs for 45s → ramp down
- Total test duration: ~75s

**Why this matters:**
- Production traffic is never 100% one endpoint. Mixed traffic reveals:
  - Connection pool exhaustion under varied query types
  - Redis contention when holds compete with reads
  - Cache invalidation interactions

**Pass criteria:**
- p95 latency < 500ms (discovery-heavy, most requests are fast reads)
- p99 latency < 1500ms
- Error rate < 3%
- All endpoint types return 2xx

**How to run:**
```bash
k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=mixedTraffic
```

---

## Concurrency Correctness Tests (Node.js Test Runner)

**File:** `tests/concurrency/movieConcurrency.test.ts`

These require a running server + PostgreSQL + Redis. They use `node --test` (Node.js built-in test runner).

### C1: Same Seats, Multiple Users

**Preconditions:** ≥1 showtime with available seats, Redis running

**Method:**
1. Create N users (register via `/api/v1/auth/register`)
2. All N users simultaneously POST `/api/v1/hold-seats` with the same 5 seat IDs
3. Count successes (200) vs conflicts (409)

**Expected result:** Exactly 1 success, N-1 conflicts

**Indicates bug if:** >1 success (double-booking possible)

### C2: Different Seats, Multiple Users

**Preconditions:** Same as C1

**Method:**
1. N users each hold a unique set of seats (no overlap)
2. Count successes

**Expected result:** All N requests succeed (200)

**Indicates bug if:** Any request fails with 409 (false collision)

### C3: Concurrent Booking Creation

**Preconditions:** Same as C1

**Method:**
1. N users simultaneously hold the same 5 seats
2. Winners (those who got the hold) create bookings
3. Count successful bookings

**Expected result:** At most 1 booking created for the same seats

**Indicates bug if:** >1 booking created (double-booking)

### C4: Idempotent Confirm

**Preconditions:** 1 user, 1 hold, 1 booking created

**Method:**
1. Create hold → create booking
2. Send 10 parallel POST requests to `/bookings/:id/confirm` with same holdKey
3. Count tickets generated

**Expected result:** Exactly 1 ticket per seat (3 tickets if 3 seats held)

**Indicates bug if:** >1 ticket per seat (duplicate ticket generation)

### C5: Cancelled Booking → Seats Re-Available

**Preconditions:** 1 user, available showtime

**Method:**
1. User 1 holds seats, creates booking
2. User 2 tries same seats → must fail (409)
3. User 1 cancels booking
4. User 2 tries same seats → must succeed (200)

**Expected result:** Step 4 returns 200

**Indicates bug if:** Step 4 still returns 409 (seats not released)

### How to Run Concurrency Tests

```bash
# Set environment
export DATABASE_URL=postgres://user:pass@localhost:5432/booking_db
export REDIS_URL=redis://localhost:6379
export CONCURRENCY=20

# Compile and run
npm run test:integration -- --test-name-pattern="movieConcurrency"

# Or directly:
npx tsc -p tsconfig.test.json && \
  NODE_ENV=test node --test '.test-build/tests/concurrency/movieConcurrency.test.js'
```

---

## Node.js Load Tester (k6 Alternative)

**File:** `tests/load/runLoadTest.mjs`

Zero-dependency load tester using Node.js native `http` module. Useful when k6 is not installed.

```bash
# Discovery: 100 VUs for 60s
BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs discovery 100 60

# Seat map: 500 VUs for 30s
BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs seatMap 500 30

# Seat competition: 500 VUs for 30s
BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs seatCompetition 500 30

# Run all scenarios sequentially
BASE_URL=http://localhost:4000 SCENARIO=all node tests/load/runLoadTest.mjs
```

**Limitations:**
- Capped at 50 actual concurrent connections (Node.js HTTP default behavior)
- No built-in metrics aggregation (manual only)
- Good for smoke testing, not for capacity measurement

---

## Known Infrastructure Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| k6 not installed on CI | Cannot run k6 scenarios | Use Node.js load tester for CI |
| PostgreSQL connection pool (default 20) | Limits concurrent DB queries | Increase `DB_CONNECTION_LIMIT` for load tests |
| Redis single instance | SPOF for seat holds | Redis Cluster for production |
| Node.js single-threaded | ~50-100 effective VU per instance | Horizontal scaling for production |
| Test user registration rate-limited | Concurrent test setup may fail | Pre-seed users via seed script |

---

## Test Execution Checklist

- [ ] PostgreSQL running with all migrations applied (`npm run db:migrate`)
- [ ] Redis running and reachable
- [ ] Server boots successfully (`npm run dev` or `npm start`)
- [ ] At least 5 movies, 3 cinemas, 20 showtimes in DB
- [ ] At least 1 verified customer user in DB
- [ ] `JWT_SECRET` set in environment
- [ ] k6 installed (`brew install k6` or `https://k6.io/docs/getting-started/installation/`)
- [ ] For concurrency tests: `CONCURRENCY` env var set (default: 20)

---

## Current Status

| Test | Status | Notes |
|------|--------|-------|
| T1: Movie Discovery | Script ready | Needs k6 + server |
| T2: Hot Seat Map | Script ready | Needs k6 + server |
| T3: Seat Competition | Script ready | Needs k6 + server |
| T4: 10-Ticket Limit | Script ready | Needs k6 + server |
| T5: Booking Flow | Script ready | Needs k6 + server |
| T6: Mixed Traffic | Script ready | Needs k6 + server |
| C1: Same seats concurrency | Test code ready | Needs server + DB + Redis |
| C2: Different seats concurrency | Test code ready | Needs server + DB + Redis |
| C3: Booking creation concurrency | Test code ready | Needs server + DB + Redis |
| C4: Idempotent confirm | Test code ready | Needs server + DB + Redis |
| C5: Cancellation re-availability | Test code ready | Needs server + DB + Redis |

**NOT MEASURED** — All test scripts and concurrency tests are written and ready. Actual execution requires:
1. A running PostgreSQL with the movie domain schema
2. A running Redis instance
3. A bootable Node.js server

When this infrastructure is available, run the k6 scenarios for load measurement and the Node.js concurrency tests for correctness verification.
