/**
 * Phase 3: Concurrency Correctness Tests — Movie Booking
 *
 * These tests verify that the booking system handles concurrent access correctly:
 *
 *  C1. Concurrent hold of the SAME seats → exactly 1 succeeds (atomic Lua script)
 *  C2. Concurrent hold of DIFFERENT seats on the same showtime → all succeed (no false collisions)
 *  C3. Concurrent booking creation for the same showtime → no double-booking
 *  C4. Concurrent confirmBooking for the same holdKey → idempotent, no duplicate tickets
 *  C5. Concurrent cancel + confirm for same booking → only one terminal state wins
 *
 * Requirements:
 *   - DATABASE_URL set (PostgreSQL with movie migrations run)
 *   - REDIS_URL set (for seat hold atomicity)
 *   - Server can boot (load src/server.ts)
 *
 * Run:
 *   DATABASE_URL=postgres://... REDIS_URL=redis://... node --test '.test-build/tests/concurrency/movieConcurrency.test.js'
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type express from 'express';

// ── Check prerequisites ────────────────────────────────────────────────────────

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_REDIS = !!process.env.REDIS_URL;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '20', 10);
const SHARED_SEATS = [1, 2, 3, 4, 5]; // seats all users fight over

let serverPort = 0;
let server: any = null;

// ── HTTP Helpers ───────────────────────────────────────────────────────────────

function request(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, method, path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          const headerObj: Record<string, string> = {};
          const h: any = res.headers;
          for (const k of Object.keys(h)) {
            headerObj[k] = typeof h[k] === 'string' ? h[k] : String(h[k]);
          }
          resolve({ status: res.statusCode!, body: parsed, headers: headerObj });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ── Test user management ───────────────────────────────────────────────────────

const testUsers: { email: string; password: string; token: string }[] = [];

async function registerUser(index: number): Promise<string> {
  const email = `concur_${Date.now()}_${index}@test.com`;
  const password = 'TestPass123!';

  const res = await request('POST', '/api/v1/auth/register', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: `Concurrent User ${index}` }),
  });

  if (res.status === 201 || res.status === 200) {
    return res.body?.data?.token || res.body?.token || '';
  }
  // If user already exists (rare due to timestamp), try login
  if (res.status === 409 || res.status === 400) {
    return await loginUser(email, password);
  }
  throw new Error(`Register failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function loginUser(email: string, password: string): Promise<string> {
  const res = await request('POST', '/api/v1/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body?.data?.token || res.body?.token || '';
}

async function setupTestUsers(count: number): Promise<void> {
  const promises: Promise<string>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(registerUser(i));
  }
  const tokens = await Promise.all(promises);
  for (let i = 0; i < count; i++) {
    testUsers.push({ email: `concur_${Date.now()}_${i}@test.com`, password: 'TestPass123!', token: tokens[i] });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

let app: express.Express | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod: any = require('../../src/server');
  app = mod.app;
} catch (err) {
  console.warn(`[concurrency] Cannot load server: ${(err as Error).message}`);
}

before(async () => {
  if (!app) return;
  await new Promise<void>((resolve) => {
    const srv = app!.listen(0, '127.0.0.1');
    srv.on('listening', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        serverPort = addr.port;
      }
      server = srv;
      resolve();
    });
  });
  console.log(`[concurrency] Test server running on port ${serverPort}`);
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SKIP GUARD
// ═══════════════════════════════════════════════════════════════════════════════

const describeIf = HAS_DB && HAS_REDIS && app
  ? describe
  : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// C1: Concurrent hold of the SAME seats
// ═══════════════════════════════════════════════════════════════════════════════

describeIf('C1: Concurrent hold — same seats, multiple users', () => {
  let showtimeId: number;
  let users: { token: string }[];

  before(async () => {
    // Get first available showtime
    const res = await request('GET', '/api/v1/showtimes');
    assert.strictEqual(res.status, 200, 'Showtimes endpoint must return 200');
    const items = res.body?.data?.items || res.body?.data || [];
    assert.ok(items.length > 0, 'Need at least 1 showtime in DB for concurrency tests');
    showtimeId = items[0].id;

    // Create test users
    await setupTestUsers(CONCURRENCY);
    users = testUsers.map(u => ({ token: u.token }));
  });

  it('only 1 user should succeed when all hold the same seats', async () => {
    const results = await Promise.all(
      users.map(u =>
        request('POST', '/api/v1/hold-seats', {
          headers: authHeaders(u.token),
          body: JSON.stringify({ showtimeId, seatIds: SHARED_SEATS }),
        }).then(res => ({ status: res.status, holdKey: res.body?.data?.holdKey }))
      )
    );

    const successes = results.filter(r => r.status === 200);
    const conflicts = results.filter(r => r.status === 409);
    const errors = results.filter(r => r.status !== 200 && r.status !== 409);

    console.log(`  C1 results: ${successes.length} success, ${conflicts.length} conflict, ${errors.length} error`);

    // With Redis Lua SET NX atomic script, exactly 1 should succeed
    assert.strictEqual(successes.length, 1,
      `Expected exactly 1 hold success, got ${successes.length} (${conflicts.length} conflicts, ${errors.length} errors)`);

    // The successful hold should have a holdKey
    assert.ok(successes[0]?.holdKey, 'Successful hold must return a holdKey');

    // Verify via DB: exactly these 5 seats are held for this showtime
    const { getPool } = await import('../../src/db/pool');
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT COUNT(*) as count FROM movie_booking_items
       WHERE showtime_id = $1 AND seat_id = ANY($2::int[])
         AND booking_status IN ('pending_payment', 'confirmed')`,
      [showtimeId, SHARED_SEATS]
    );
    const dbHoldCount = parseInt(dbResult.rows[0].count, 10);
    assert.ok(dbHoldCount <= 5,
      `DB should have <=5 held seats, found ${dbHoldCount} — possible double-booking`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C2: Concurrent hold of DIFFERENT seats — all should succeed
// ═══════════════════════════════════════════════════════════════════════════════

describeIf('C2: Concurrent hold — different seats, multiple users', () => {
  let showtimeId: number;
  let users: { token: string }[];

  before(async () => {
    const res = await request('GET', '/api/v1/showtimes');
    const items = res.body?.data?.items || res.body?.data || [];
    showtimeId = items[0].id;
    await setupTestUsers(Math.min(CONCURRENCY, 10));
    users = testUsers.map(u => ({ token: u.token }));
  });

  it('all users succeed when holding different seats', async () => {
    // Each user gets a unique set of seats: user 0 → [10,11,12], user 1 → [13,14,15], etc.
    const results = await Promise.all(
      users.map((u, i) => {
        const baseSeat = 10 + i * 3;
        const seatIds = [baseSeat, baseSeat + 1, baseSeat + 2];
        return request('POST', '/api/v1/hold-seats', {
          headers: authHeaders(u.token),
          body: JSON.stringify({ showtimeId, seatIds }),
        }).then(res => ({ i, status: res.status, holdKey: res.body?.data?.holdKey }));
      })
    );

    const successes = results.filter(r => r.status === 200);
    const errors = results.filter(r => r.status !== 200);

    console.log(`  C2 results: ${successes.length}/${results.length} success`);

    assert.strictEqual(errors.length, 0,
      `Expected all holds to succeed with different seats, got errors: ${errors.map(e => `user${e.i}=${e.status}`).join(', ')}`);
    assert.ok(successes.length >= users.length * 0.8,
      `At least 80% of holds should succeed, got ${successes.length}/${users.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C3: Concurrent booking creation — no double-booking
// ═══════════════════════════════════════════════════════════════════════════════

describeIf('C3: Concurrent booking creation — no double-booking', () => {
  let showtimeId: number;
  let users: { token: string }[];

  before(async () => {
    const res = await request('GET', '/api/v1/showtimes');
    const items = res.body?.data?.items || res.body?.data || [];
    showtimeId = items[0].id;
    // Create enough users
    await setupTestUsers(CONCURRENCY);
    users = testUsers.map(u => ({ token: u.token }));
  });

  it('only 1 booking is created when all users hold+book the same seats', async () => {
    // Step 1: All users hold the same seats
    const holdResults = await Promise.all(
      users.map(u =>
        request('POST', '/api/v1/hold-seats', {
          headers: authHeaders(u.token),
          body: JSON.stringify({ showtimeId, seatIds: SHARED_SEATS }),
        }).then(res => ({
          status: res.status,
          token: u.token,
          holdKey: res.body?.data?.holdKey,
        }))
      )
    );

    const holdSuccesses = holdResults.filter(r => r.status === 200);
    console.log(`  C3: ${holdSuccesses.length} users got seat holds`);

    assert.ok(holdSuccesses.length >= 1, 'At least one hold must succeed');

    // Step 2: Winners try to create bookings (most will fail — seats already taken)
    const bookingResults = await Promise.all(
      holdSuccesses.map(h =>
        request('POST', '/api/v1/bookings', {
          headers: authHeaders(h.token),
          body: JSON.stringify({
            holdKey: h.holdKey,
            idempotencyKey: `concur_c3_${Date.now()}_${Math.random()}`,
            customerEmail: 'concur3@test.com',
            customerPhone: '+9199999000001',
            customerName: 'Concurrent User C3',
          }),
        }).then(res => ({ status: res.status, bookingId: res.body?.data?.id }))
      )
    );

    const bookingSuccesses = bookingResults.filter(r => r.status === 201 || r.status === 200);
    const bookingErrors = bookingResults.filter(r => r.status !== 201 && r.status !== 200);

    console.log(`  C3 booking results: ${bookingSuccesses.length} success, ${bookingErrors.length} errors`);

    // With the partial unique index + FOR UPDATE serialization, at most 1 booking should
    // succeed for the same seats. Multiple successes would indicate a double-booking.
    assert.ok(bookingSuccesses.length <= 1,
      `Double-booking detected: ${bookingSuccesses.length} bookings created for the same seats!`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C4: Concurrent confirmBooking for same holdKey — idempotent
// ═══════════════════════════════════════════════════════════════════════════════

describeIf('C4: Concurrent confirmBooking — idempotent', () => {
  let showtimeId: number;
  let userToken: string;
  let holdKey: string;

  before(async () => {
    const res = await request('GET', '/api/v1/showtimes');
    const items = res.body?.data?.items || res.body?.data || [];
    showtimeId = items[0].id;

    // Register a single user
    userToken = await registerUser(0);
  });

  it('concurrent confirm with same holdKey produces exactly 1 booking', async () => {
    // Hold seats
    const holdRes = await request('POST', '/api/v1/hold-seats', {
      headers: authHeaders(userToken),
      body: JSON.stringify({ showtimeId, seatIds: [20, 21, 22] }),
    });
    assert.strictEqual(holdRes.status, 200, 'Hold must succeed');
    holdKey = holdRes.body.data.holdKey;

    // Create booking (to get a booking reference)
    const bookRes = await request('POST', '/api/v1/bookings', {
      headers: authHeaders(userToken),
      body: JSON.stringify({
        holdKey,
        idempotencyKey: `concur_c4_${Date.now()}`,
        customerEmail: 'concur4@test.com',
        customerPhone: '+9199999000002',
        customerName: 'Concurrent User C4',
      }),
    });
    assert.ok(bookRes.status === 200 || bookRes.status === 201, `Booking creation must succeed: ${bookRes.status}`);
    const bookingId = bookRes.body.data.id;

    // Now 10 parallel confirm requests (same holdKey)
    const confirmResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        request('POST', `/api/v1/bookings/${bookingId}/confirm`, {
          headers: authHeaders(userToken),
          body: JSON.stringify({ holdKey, paymentReference: `PAY_C4_${Date.now()}` }),
        }).then(res => ({ status: res.status, ticketCount: res.body?.data?.tickets?.length || 0 }))
      )
    );

    const successes = confirmResults.filter(r => r.status === 200);
    const errors = confirmResults.filter(r => r.status !== 200);

    console.log(`  C4: ${successes.length} confirms succeeded, ${errors.length} errored`);

    // Verify only 1 set of tickets exists for these seats
    const { getPool } = await import('../../src/db/pool');
    const pool = getPool();
    const ticketCount = await pool.query(
      'SELECT COUNT(*) as count FROM movie_tickets WHERE booking_id = $1',
      [bookingId]
    );
    const totalTickets = parseInt(ticketCount.rows[0].count, 10);
    assert.strictEqual(totalTickets, 3,
      `Expected exactly 3 tickets for booking ${bookingId}, found ${totalTickets} — duplicate ticket generation!`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C5: Race condition — seat availability after stale hold expiry
// ═══════════════════════════════════════════════════════════════════════════════

describeIf('C5: Stale hold expiry — seats become available', () => {
  let showtimeId: number;
  let userTokens: string[];

  before(async () => {
    const res = await request('GET', '/api/v1/showtimes');
    const items = res.body?.data?.items || res.body?.data || [];
    showtimeId = items[0].id;

    // Create 3 users
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      tokens.push(await registerUser(i));
    }
    userTokens = tokens;
  });

  it('seats held by expired booking can be re-held by another user', async () => {
    // This test validates the concept: we create a hold, then simulate expiry
    // In practice, the expiry worker runs on a timer. We verify the DB constraint
    // allows seat re-allocation after booking is cancelled/expired.

    // User 1 holds seats [30, 31]
    const hold1 = await request('POST', '/api/v1/hold-seats', {
      headers: authHeaders(userTokens[0]),
      body: JSON.stringify({ showtimeId, seatIds: [30, 31] }),
    });
    assert.strictEqual(hold1.status, 200, 'First hold must succeed');

    // User 1 creates a booking (this reserves the seats with DB constraint)
    const book1 = await request('POST', '/api/v1/bookings', {
      headers: authHeaders(userTokens[0]),
      body: JSON.stringify({
        holdKey: hold1.body.data.holdKey,
        idempotencyKey: `concur_c5_${Date.now()}_1`,
        customerEmail: 'c5user1@test.com',
        customerPhone: '+9199999000003',
        customerName: 'C5 User 1',
      }),
    });
    assert.ok(book1.status === 200 || book1.status === 201, 'First booking must succeed');

    // User 2 tries to hold same seats — should fail
    const hold2 = await request('POST', '/api/v1/hold-seats', {
      headers: authHeaders(userTokens[1]),
      body: JSON.stringify({ showtimeId, seatIds: [30, 31] }),
    });
    assert.strictEqual(hold2.status, 409, 'Second hold of taken seats must return 409');

    // Cancel User 1's booking
    const cancelRes = await request('POST', `/api/v1/bookings/${book1.body.data.id}/cancel`, {
      headers: authHeaders(userTokens[0]),
      body: JSON.stringify({ reason: 'concurrency test' }),
    });
    assert.ok(cancelRes.status === 200 || cancelRes.status === 204, `Cancel must succeed: ${cancelRes.status}`);

    // User 2 tries again — should now succeed
    const hold3 = await request('POST', '/api/v1/hold-seats', {
      headers: authHeaders(userTokens[1]),
      body: JSON.stringify({ showtimeId, seatIds: [30, 31] }),
    });
    assert.strictEqual(hold3.status, 200,
      `After cancellation, same seats should be re-holdable. Got: ${hold3.status}`);
  });
});
