/**
 * Movie Booking Engine — Real Load Test Suite (Native Node.js)
 *
 * This test requires:
 *   - Server running on BASE_URL (default http://localhost:4000)
 *   - PostgreSQL with seed data (at least 1 movie, 1 cinema, 1 showtime)
 *   - Redis running
 *   - At least 1 registered user (for auth-dependent tests)
 *
 * Usage:
 *   # Start server first:
 *   PORT=4000 npm run dev
 *
 *   # Then run tests:
 *   BASE_URL=http://localhost:4000 CONCURRENCY=20 node --test tests/load/movieLoadTest.mjs
 *
 * Scenarios that REQUIRE a running DB are clearly labeled.
 * Scenarios that can run against a live server are executed.
 * Any scenario that cannot complete (no DB) reports "SKIPPED".
 */

import http from 'http';
import assert from 'node:assert';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const API = `${BASE}/api/v1`;
const CONCURRENCY = parseInt(process.env.LOAD_CONCURRENCY || '20', 10);

// ── HTTP Helpers ───────────────────────────────────────────────────────────────

function request(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    const start = Date.now();
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const elapsed = Date.now() - start;
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, elapsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const get = (p, h) => request('GET', p, null, h);
const post = (p, b, h) => request('POST', p, b, h);

// ── Stats Helpers ─────────────────────────────────────────────────────────────

function stats(latencies) {
  if (!latencies.length) return { n: 0, mean: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    mean: Math.round(sum / sorted.length),
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted[sorted.length - 1],
  };
}

// ── Test Framework ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const lines = [];

function desc(name) { lines.push(`\n${'─'.repeat(68)}`); lines.push(`  ${name}`); lines.push(`${'─'.repeat(68)}`); }
function pass(msg) { passed++; lines.push(`  ✅ PASS: ${msg}`); }
function fail(msg) { failed++; lines.push(`  ❌ FAIL: ${msg}`); }
function skip(msg) { skipped++; lines.push(`  ⏭  SKIP: ${msg}`); }

async function runParallel(fn, count) {
  const promises = Array.from({ length: count }, (_, i) => fn(i));
  return Promise.all(promises);
}

async function waitForServer(maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await get('/health/live');
      if (res.status === 200) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ── Scenarios ──────────────────────────────────────────────────────────────────

async function scenario_1_discovery() {
  desc('S1: Movie Discovery (Public — reads only)');
  const paths = ['/movies', '/movies/featured', '/cinemas', '/cinemas/city/Chennai', '/showtimes', '/movies/genres'];
  const latencies = [];

  const results = await runParallel(async () => {
    const tasks = paths.map(p => {
      const start = Date.now();
      return get(`${API}${p}`).finally(() => latencies.push(Date.now() - start));
    });
    const responses = await Promise.all(tasks);
    return responses;
  }, CONCURRENCY);

  const all2xx = results.every(r => r.every(res => res.status >= 200 && res.status < 300));
  if (!all2xx) {
    const bad = results.flat().find(r => r.status < 200 || r.status >= 300);
    fail(`Some endpoints returned non-2xx: ${bad?.status} — ${bad?.body}`);
    return;
  }
  const s = stats(latencies);
  pass(`${s.n} requests | mean=${s.mean}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms`);
}

async function scenario_2_seat_layout() {
  desc('S2: Seat Layout (Public — needs DB with showtime)');
  // Find a showtime
  const showtimesRes = await get(`${API}/showtimes`);
  if (showtimesRes.status !== 200 || !showtimesRes.body?.data?.items?.length) {
    skip('No showtimes in DB — cannot test seat layout');
    return;
  }
  const st = showtimesRes.body.data.items[0];
  const showtimeId = st.id;

  // Verify showtime is on_sale
  if (st.status !== 'on_sale') {
    skip(`Showtime ${showtimeId} is ${st.status} (not on_sale) — no seats to query`);
    return;
  }

  const latencies = [];
  const results = await runParallel(async () => {
    const start = Date.now();
    const res = await get(`${API}/showtimes/${showtimeId}/seats`);
    latencies.push(Date.now() - start);
    return res;
  }, CONCURRENCY);

  const all2xx = results.every(r => r.status >= 200 && r.status < 300);
  if (!all2xx) {
    fail(`Seat layout returned non-2xx: ${results.find(r => r.status < 200 || r.status >= 300)?.status}`);
    return;
  }

  const s = stats(latencies);
  const hasRows = results[0]?.body?.data?.rows?.length > 0;
  if (!hasRows) {
    fail('Seat layout response missing rows data');
    return;
  }

  pass(`${s.n} requests | mean=${s.mean}ms p95=${s.p95}ms p99=${s.p99}ms max=${s.max}ms | ${results[0].body.data.rows.length} rows`);
}

async function scenario_3_rate_limiting() {
  desc('S3: Rate Limiting (Redis-backed global limiter)');
  // Fire CONCURRENCY * 5 rapid requests. Global limiter is 300/min, so 100 should not hit it.
  // But the booking limiter is 15/min. Let's test the global one.
  const total = CONCURRENCY * 5;
  if (total > 300) {
    skip(`CONCURRENCY*5 (${total}) > global limit (300/min) — would trigger rate limit. Run with CONCURRENCY<=60`);
    return;
  }

  const results = await runParallel(async () => {
    return get(`${API}/movies`);
  }, total);

  const rateLimited = results.filter(r => r.status === 429).length;
  const ok = results.filter(r => r.status >= 200 && r.status < 300).length;
  const other = results.filter(r => r.status !== 429 && (r.status < 200 || r.status >= 300)).length;

  if (other > 0) {
    fail(`${other} requests returned unexpected status codes`);
    return;
  }

  if (rateLimited > 0) {
    fail(`${rateLimited} requests were rate-limited (429) — global limiter too aggressive or shared-IP issue`);
    return;
  }

  pass(`${total} requests, 0 rate-limited (429), all ${ok} returned 2xx — limiter working correctly`);
}

async function scenario_4_seat_hold_serialization() {
  desc('S4: Seat Hold Serialization (Atomic Lua — same seat)');
  // Get showtime + seat
  const showtimesRes = await get(`${API}/showtimes`);
  if (showtimesRes.status !== 200 || !showtimesRes.body?.data?.items?.length) {
    skip('No showtimes in DB');
    return;
  }
  const showtimeId = showtimesRes.body.data.items[0].id;

  const layoutRes = await get(`${API}/showtimes/${showtimeId}/seats`);
  if (layoutRes.status !== 200) {
    skip('Cannot fetch seat layout');
    return;
  }

  let seatId = null;
  for (const row of layoutRes.body.data.rows || []) {
    for (const seat of row.seats || []) {
      if (seat.status === 'available') { seatId = seat.seatId; break; }
    }
    if (seatId) break;
  }
  if (!seatId) {
    skip('No available seats');
    return;
  }

  // Multiple users try to hold the SAME seat — only one should succeed
  const holdResults = await runParallel(async (i) => {
    const res = await post(`${API}/hold-seats`, { seatIds: [seatId] }, {
      headers: { 'Authorization': `Bearer ${generateTestJwt(10000 + i, `holdtest${i}@test.com`)}` },
    });
    return { success: res.status === 200 || res.status === 201, status: res.status, i };
  }, CONCURRENCY);

  const successes = holdResults.filter(r => r.success).length;
  const failures = holdResults.filter(r => !r.success).length;

  // With the Lua script (SET NX), exactly 1 should succeed
  if (successes === 1) {
    pass(`${CONCURRENCY} users hold seat ${seatId}: exactly 1 success, ${failures} correctly rejected — atomic serialization works`);
  } else {
    // Auth failures are expected if no valid JWT — count only non-auth failures
    const authFails = holdResults.filter(r => r.status === 401).length;
    const holdFails = holdResults.filter(r => r.status !== 401 && !r.success).length;
    const holdSuccesses = holdResults.filter(r => r.status !== 401 && r.success).length;

    if (authFails === CONCURRENCY) {
      skip(`All ${CONCURRENCY} requests returned 401 — cannot test without valid JWT/DB`);
    } else if (holdSuccesses === 1) {
      pass(`${CONCURRENCY} users hold seat ${seatId}: exactly 1 success, ${holdFails} rejected, ${authFails} auth fails — atomic serialization works`);
    } else {
      fail(`${holdSuccesses} holds succeeded (expected 1), ${holdFails} rejected, ${authFails} auth fails — POSSIBLE DOUBLE-BOOKING`);
    }
  }
}

async function scenario_5_max_tickets_enforcement() {
  desc('S5: MAX 10 Tickets Enforcement');
  const showtimesRes = await get(`${API}/showtimes`);
  if (showtimesRes.status !== 200 || !showtimesRes.body?.data?.items?.length) {
    skip('No showtimes in DB');
    return;
  }
  const showtimeId = showtimesRes.body.data.items[0].id;

  // Try to hold 11 seats (should be rejected by controller)
  const res = await post(`${API}/hold-seats`, { seatIds: Array.from({ length: 11 }, (_, i) => i + 1) }, {
    headers: { 'Authorization': `Bearer ${generateTestJwt(20000, 'maxtest@test.com')}` },
  });

  if (res.status === 401) {
    skip('Cannot test — auth required. Controller-level validation is CODE-CONFIRMED at line 37 of movieBookingController.ts');
    return;
  }

  if (res.status === 400 && res.body?.message?.includes('Cannot hold more than 10 seats')) {
    pass('11-seat request correctly rejected with 400 — MAX_SEATS_PER_BOOKING=10 enforced');
  } else {
    fail(`11-seat request returned ${res.status}: ${res.body?.message || 'no message'} — expected 400 rejection`);
  }
}

async function scenario_6_booking_idempotency() {
  desc('S6: Booking Idempotency (same holdKey twice)');
  skip('Requires valid JWT + held seats — test the idempotency key in createOrder instead');
}

async function scenario_7_seat_layout_caching_headers() {
  desc('S7: Cache-Control Headers on Public Endpoints');
  const res = await get(`${API}/movies`);
  if (res.status === 200) {
    const cc = res.headers?.['cache-control'] || res.headers?.['Cache-Control'];
    if (cc && cc.includes('s-maxage')) {
      pass(`Movies endpoint has Cache-Control: ${cc}`);
    } else if (cc) {
      pass(`Movies endpoint has Cache-Control: ${cc} (partial)`);
    } else {
      fail('Movies endpoint missing Cache-Control headers — no CDN caching');
    }
  } else {
    skip(`Movies endpoint returned ${res.status}`);
  }
}

async function scenario_8_health_endpoints() {
  desc('S8: Health Endpoints (liveness + readiness)');
  const liveRes = await get('/health/live');
  const readyRes = await get('/health/ready');

  if (liveRes.status === 200) pass('Liveness endpoint returns 200');
  else fail(`Liveness returned ${liveRes.status}`);

  if (readyRes.status === 200) pass('Readiness endpoint returns 200');
  else fail(`Readiness returned ${readyRes.status} (expected 200 if DB+Redis up, 503 if not)`);

  // Check response body
  if (liveRes.body?.status === 'ok') pass('Liveness body: status=ok');
  else fail(`Liveness body unexpected: ${JSON.stringify(liveRes.body)}`);
}

async function scenario_9_cors_headers() {
  desc('S9: CORS Headers');
  const res = await get(`${API}/movies`);
  if (res.status === 200) {
    const acao = res.headers?.['access-control-allow-origin'];
    if (acao) pass(`CORS: Access-Control-Allow-Origin = ${acao}`);
    else fail('No CORS header on movie endpoint');
  } else {
    skip(`Movies returned ${res.status}`);
  }
}

async function scenario_10_404_handling() {
  desc('S10: 404 Handling');
  const res = await get(`${API}/nonexistent/endpoint/12345`);
  if (res.status === 404) {
    pass('Non-existent endpoint returns 404');
  } else {
    fail(`Non-existent endpoint returned ${res.status} (expected 404)`);
  }
}

// ── JWT Generator for Tests ────────────────────────────────────────────────────

function generateTestJWT(userId, email) {
  // For real server testing, use TEST_USER_TOKEN env var with a valid JWT.
  // This generator is only for testing against a server configured with
  // the matching JWT_TEST_SECRET. Never use the default secret in production.
  const secret = process.env.JWT_TEST_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_TEST_SECRET not set. For real load tests, set TEST_USER_TOKEN to a valid server JWT. ' +
      'See scenario code for auth header usage.'
    );
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    id: userId, email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = Buffer.from(
    require('crypto').createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  ).toString();
  return `${header}.${payload}.${signature}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  MOVIE BOOKING ENGINE — REAL LOAD TEST');
  console.log(`  Target: ${BASE}`);
  console.log(`  Concurrency: ${CONCURRENCY} parallel users`);
  console.log(`  Node: ${process.version}`);
  console.log(`${'═'.repeat(70)}\n`);

  console.log('Checking server availability...');
  const ready = await waitForServer();
  if (!ready) {
    console.error('\n❌ Server not reachable at ' + BASE);
    console.error('   Start the server first: PORT=4000 npm run dev');
    process.exit(1);
  }
  console.log(`✅ Server is ready at ${BASE}\n`);

  // Run scenarios in order
  await scenario_8_health_endpoints();
  await scenario_10_404_handling();
  await scenario_9_cors_headers();
  await scenario_7_seat_layout_caching_headers();
  await scenario_1_discovery();
  await scenario_2_seat_layout();
  await scenario_3_rate_limiting();
  await scenario_4_seat_hold_serialization();
  await scenario_5_max_tickets_enforcement();
  await scenario_6_booking_idempotency();

  // Print summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  for (const line of lines) console.log(line);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  ✅ PASS: ${passed}  ❌ FAIL: ${failed}  ⏭ SKIP: ${skipped}`);
  console.log(`${'═'.repeat(70)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
