/**
 * k6 Load Test Suite for Movie Booking System
 *
 * Prerequisites:
 *   k6 installed (brew install k6, or https://k6.io/docs/getting-started/installation/)
 *
 * Environment Variables:
 *   BASE_URL           — Server base URL (default: http://localhost:4000)
 *   TEST_USER_TOKEN    — JWT bearer token for authenticated requests
 *   MOVIE_ID           — Movie ID for discovery tests (default: 1)
 *   CINEMA_ID          — Cinema ID for discovery tests (default: 1)
 *   SHOWTIME_ID        — Showtime ID for seat/booking tests (default: 1)
 *   SCREEN_ID          — Screen ID for seat layout tests (default: 1)
 *   SEAT_IDS           — Comma-separated seat IDs for hold tests (default: 1,2,3,4,5)
 *   SCENARIO           — Scenario name to run, or "all" for all scenarios
 *
 * Usage:
 *   k6 run tests/load/movieBookingLoadTest.js                          # run all
 *   k6 run tests/load/movieBookingLoadTest.js --env SCENARIO=discovery # single scenario
 *   k6 run tests/load/movieBookingLoadTest.js --vus 200 --duration 30s # override VUs/duration
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';

// ── Configuration ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Scenario A: Movie Discovery — ramp to 500 VUs, hold 60s, ramp down
    discovery: {
      executor: 'ramping-vus',
      startVUs: 50,
      stages: [
        { duration: '15s', target: 200 },
        { duration: '45s', target: 500 },
        { duration: '15s', target: 50 },
      ],
      exec: 'discovery',
      tags: { scenario: 'discovery' },
    },
    // Scenario B: Hot Showtime Seat Map — 300 VUs for 30s
    seatMap: {
      executor: 'ramping-vus',
      startVUs: 50,
      stages: [
        { duration: '10s', target: 300 },
        { duration: '30s', target: 300 },
        { duration: '10s', target: 0 },
      ],
      exec: 'seatMap',
      tags: { scenario: 'seatMap' },
    },
    // Scenario C: Seat Competition — 200 VUs hammering the same seats
    seatCompetition: {
      executor: 'ramping-vus',
      startVUs: 20,
      stages: [
        { duration: '10s', target: 200 },
        { duration: '30s', target: 200 },
        { duration: '10s', target: 0 },
      ],
      exec: 'seatCompetition',
      tags: { scenario: 'seatCompetition' },
    },
    // Scenario D: 10-Ticket Limit — 50 VUs for boundary testing
    tenTicketLimit: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5s', target: 50 },
        { duration: '20s', target: 50 },
        { duration: '5s', target: 0 },
      ],
      exec: 'tenTicketLimit',
      tags: { scenario: 'tenTicketLimit' },
    },
    // Scenario E: Full Booking Flow — 100 VUs going through hold → book → (mock) pay
    bookingFlow: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '40s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      exec: 'bookingFlow',
      tags: { scenario: 'bookingFlow' },
    },
    // Scenario F: Mixed Realistic Traffic — mirrors real user behavior
    //   70% discovery, 15% seat map, 8% seat hold, 4% booking, 2% payment check, 1% search
    mixedTraffic: {
      executor: 'ramping-vus',
      startVUs: 20,
      stages: [
        { duration: '15s', target: 200 },
        { duration: '45s', target: 300 },
        { duration: '15s', target: 0 },
      ],
      exec: 'mixedTraffic',
      tags: { scenario: 'mixedTraffic' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:discovery}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:seatMap}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:seatCompetition}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:tenTicketLimit}': ['p(95)<500'],
    'http_req_duration{scenario:bookingFlow}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{scenario:mixedTraffic}': ['p(95)<500', 'p(99)<1500'],
    'http_req_failed{scenario:discovery}': ['rate<0.01'],
    'http_req_failed{scenario:seatMap}': ['rate<0.01'],
    'http_req_failed{scenario:seatCompetition}': ['rate<0.01'],
    'http_req_failed{scenario:tenTicketLimit}': ['rate<0.01'],
    'http_req_failed{scenario:bookingFlow}': ['rate<0.05'],
    'http_req_failed{scenario:mixedTraffic}': ['rate<0.03'],
  },
};

// ── Custom Metrics ──────────────────────────────────────────────────────────

export const errorRate = new Rate('errors');
export const seatHoldSuccesses = new Counter('seat_hold_successes');
export const seatHoldRejections = new Counter('seat_hold_rejections');
export const bookingCreated = new Counter('booking_created');
export const bookingRejected = new Counter('booking_rejected');

// ── Environment ─────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const TEST_USER_TOKEN = __ENV.TEST_USER_TOKEN || '';
const MOVIE_ID = __ENV.MOVIE_ID || '1';
const CINEMA_ID = __ENV.CINEMA_ID || '1';
const SHOWTIME_ID = __ENV.SHOWTIME_ID || '1';
const SCREEN_ID = __ENV.SCREEN_ID || '1';
const SEAT_IDS = (__ENV.SEAT_IDS || '1,2,3,4,5').split(',').map(s => parseInt(s, 10));

// ── Auth Header ─────────────────────────────────────────────────────────────

const authHeaders = TEST_USER_TOKEN
  ? { Authorization: `Bearer ${TEST_USER_TOKEN}` }
  : {};
const commonHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  ...authHeaders,
};

// ── Scenario A: Discovery ───────────────────────────────────────────────────

export function discovery() {
  const endpoints = [
    { method: 'GET', path: '/api/v1/movies' },
    { method: 'GET', path: `/api/v1/movies/${MOVIE_ID}` },
    { method: 'GET', path: '/api/v1/cinemas' },
    { method: 'GET', path: `/api/v1/cinemas/${CINEMA_ID}` },
    { method: 'GET', path: '/api/v1/showtimes' },
    { method: 'GET', path: '/api/v1/movies/featured' },
    { method: 'GET', path: '/api/v1/movies/genres' },
    { method: 'GET', path: '/api/v1/movies/search?q=action' },
    { method: 'GET', path: '/api/v1/movies/languages' },
  ];

  const ep = endpoints[Math.floor(Math.random() * endpoints.length)];

  let res;
  if (ep.method === 'GET') {
    res = http.get(`${BASE_URL}${ep.path}`, { headers: commonHeaders, tags: { scenario: 'discovery' } });
  }

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is JSON': (r) => r.headers['Content-Type']?.includes('json'),
    'has success field': (r) => {
      try { return r.json().success === true || r.json().data !== undefined; }
      catch { return false; }
    },
  });

  errorRate.add(!ok);
  sleep(0.1 + Math.random() * 0.3);
}

// ── Scenario B: Seat Map ────────────────────────────────────────────────────

export function seatMap() {
  const res = http.get(
    `${BASE_URL}/api/v1/showtimes/${SHOWTIME_ID}/seats`,
    { headers: commonHeaders, tags: { scenario: 'seatMap' } }
  );

  const ok = check(res, {
    'seat map status 200': (r) => r.status === 200,
    'has seat layout': (r) => {
      try {
        const data = r.json();
        return data.data && (data.data.seats || data.data.screen) !== undefined;
      } catch { return false; }
    },
    'seat count > 0': (r) => {
      try {
        const data = r.json();
        return data.data && (data.data.seats || []).length > 0;
      } catch { return false; }
    },
  });

  errorRate.add(!ok);
  sleep(0.1 + Math.random() * 0.3);
}

// ── Scenario C: Seat Competition ────────────────────────────────────────────

export function seatCompetition() {
  const res = http.post(
    `${BASE_URL}/api/v1/hold-seats`,
    JSON.stringify({ showtimeId: parseInt(SHOWTIME_ID, 10), seatIds: SEAT_IDS }),
    { headers: commonHeaders, tags: { scenario: 'seatCompetition' } }
  );

  const success = check(res, {
    'hold response 200 or 409': (r) => r.status === 200 || r.status === 409,
    'has success field': (r) => {
      try { return typeof r.json().success === 'boolean'; }
      catch { return false; }
    },
  });

  if (success && res.status === 200) {
    seatHoldSuccesses.add(1);
  } else if (success && res.status === 409) {
    seatHoldRejections.add(1);
  }

  errorRate.add(!success);
  sleep(0.05 + Math.random() * 0.1);
}

// ── Scenario D: 10-Ticket Limit ─────────────────────────────────────────────

export function tenTicketLimit() {
  // Test with 1, 5, 10, 11, 20 seats
  const testCases = [1, 5, 10, 11, 20];
  const count = testCases[Math.floor(Math.random() * testCases.length)];
  const seatIds = Array.from({ length: Math.min(count, 50) }, (_, i) => i + 1);

  const res = http.post(
    `${BASE_URL}/api/v1/hold-seats`,
    JSON.stringify({ showtimeId: parseInt(SHOWTIME_ID, 10), seatIds }),
    { headers: commonHeaders, tags: { scenario: 'tenTicketLimit' } }
  );

  let ok;
  if (count <= 10) {
    ok = check(res, {
      '<=10 seats: 200 or 409': (r) => r.status === 200 || r.status === 409,
    });
  } else {
    ok = check(res, {
      '>10 seats: 400': (r) => r.status === 400,
      'rejected with correct message': (r) => {
        try { return r.json().message === 'Cannot hold more than 10 seats at once'; }
        catch { return false; }
      },
    });
  }

  errorRate.add(!ok);
  sleep(0.2);
}

// ── Scenario E: Booking Flow (hold → book → check status) ───────────────────

export function bookingFlow() {
  // Step 1: Hold seats (use unique seat IDs per VU iteration to avoid constant conflicts)
  const seatIds = Array.from({ length: 5 }, (_, i) => 100 + i + Math.floor(Math.random() * 100));
  const holdRes = http.post(
    `${BASE_URL}/api/v1/hold-seats`,
    JSON.stringify({ showtimeId: parseInt(SHOWTIME_ID, 10), seatIds }),
    { headers: commonHeaders, tags: { scenario: 'bookingFlow' } }
  );

  if (holdRes.status !== 200) {
    errorRate.add(true);
    return sleep(0.3);
  }

  // Step 2: Create booking
  const bookingRes = http.post(
    `${BASE_URL}/api/v1/bookings`,
    JSON.stringify({
      holdKey: holdRes.json('data').holdKey,
      idempotencyKey: `loadtest_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      customerEmail: 'loadtest@example.com',
      customerPhone: '+919999999999',
      customerName: 'Load Tester',
    }),
    { headers: commonHeaders, tags: { scenario: 'bookingFlow' } }
  );

  if (bookingRes.status === 201) {
    bookingCreated.add(1);
  } else {
    bookingRejected.add(1);
  }

  errorRate.add(bookingRes.status !== 201);
  sleep(0.3);
}

// ── Scenario F: Mixed Realistic Traffic ──────────────────────────────────────

export function mixedTraffic() {
  // Traffic distribution mirroring real user behavior:
  //   70% discovery  |  15% seat map  |  8% seat hold  |  4% booking  |  2% search  |  1% genres
  const roll = Math.random();

  if (roll < 0.70) {
    // Discovery — 70%
    const endpoints = [
      { path: '/api/v1/movies' },
      { path: `/api/v1/movies/${MOVIE_ID}` },
      { path: '/api/v1/cinemas' },
      { path: '/api/v1/showtimes' },
      { path: '/api/v1/movies/featured' },
    ];
    const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
    const res = http.get(`${BASE_URL}${ep.path}`, {
      headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'discovery' },
    });
    errorRate.add(res.status !== 200);
  } else if (roll < 0.85) {
    // Seat Map — 15%
    const res = http.get(`${BASE_URL}/api/v1/showtimes/${SHOWTIME_ID}/seats`, {
      headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'seatMap' },
    });
    errorRate.add(res.status !== 200);
  } else if (roll < 0.93) {
    // Seat Hold — 8%
    const seatIds = [1, 2, 3];
    const res = http.post(
      `${BASE_URL}/api/v1/hold-seats`,
      JSON.stringify({ showtimeId: parseInt(SHOWTIME_ID, 10), seatIds }),
      { headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'hold' } }
    );
    if (res.status === 200) seatHoldSuccesses.add(1);
    else if (res.status === 409) seatHoldRejections.add(1);
    errorRate.add(res.status !== 200 && res.status !== 409);
  } else if (roll < 0.97) {
    // Booking — 4%
    const seatIds = Array.from({ length: 3 }, (_, i) => 200 + i + Math.floor(Math.random() * 50));
    const holdRes = http.post(
      `${BASE_URL}/api/v1/hold-seats`,
      JSON.stringify({ showtimeId: parseInt(SHOWTIME_ID, 10), seatIds }),
      { headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'hold' } }
    );
    if (holdRes.status === 200) {
      const bookingRes = http.post(
        `${BASE_URL}/api/v1/bookings`,
        JSON.stringify({
          holdKey: holdRes.json('data').holdKey,
          idempotencyKey: `mixed_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          customerEmail: 'mixed@example.com',
          customerPhone: '+919999999998',
          customerName: 'Mixed User',
        }),
        { headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'booking' } }
      );
      if (bookingRes.status === 201) bookingCreated.add(1);
      else bookingRejected.add(1);
      errorRate.add(bookingRes.status !== 201);
    } else {
      errorRate.add(true);
    }
  } else if (roll < 0.99) {
    // Search — 2%
    const res = http.get(`${BASE_URL}/api/v1/movies/search?q=action`, {
      headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'search' },
    });
    errorRate.add(res.status !== 200);
  } else {
    // Genres — 1%
    const res = http.get(`${BASE_URL}/api/v1/movies/genres`, {
      headers: commonHeaders, tags: { scenario: 'mixedTraffic', type: 'genres' },
    });
    errorRate.add(res.status !== 200);
  }

  sleep(0.1 + Math.random() * 0.4);
}

// ── Export custom metrics summary ───────────────────────────────────────────

export function handleSummary(data) {
  return {
    'stdout': textSummary(data),
    'load-test-results.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  let out = '\n\n═══════════════════════════════════════════════════════════\n';
  out += '  MOVIE BOOKING LOAD TEST SUMMARY\n';
  out += '═══════════════════════════════════════════════════════════\n\n';

  const metrics = data.metrics;
  const byScenario = {};

  // Group by scenario
  for (const [key, val] of Object.entries(metrics)) {
    if (key.startsWith('http_req_duration')) {
      const match = key.match(/\{scenario:(\w+)\}/);
      if (match) {
        if (!byScenario[match[1]]) byScenario[match[1]] = {};
        byScenario[match[1]].duration = val;
      }
    }
    if (key.startsWith('http_req_failed')) {
      const match = key.match(/\{scenario:(\w+)\}/);
      if (match) {
        if (!byScenario[match[1]]) byScenario[match[1]] = {};
        byScenario[match[1]].errorRate = val;
      }
    }
  }

  const scenarios = ['discovery', 'seatMap', 'seatCompetition', 'tenTicketLimit', 'bookingFlow', 'mixedTraffic'];
  for (const sc of scenarios) {
    const dur = byScenario[sc]?.duration;
    const err = byScenario[sc]?.errorRate;
    out += `  ${sc.padEnd(20)} | `;
    if (dur) {
      out += `p95=${dur.values.p95.toFixed(0)}ms p99=${dur.values.p99.toFixed(0)}ms`;
    } else {
      out += 'NOT RUN';
    }
    out += ` | errors=${err ? (err.values.rate * 100).toFixed(2) : 'N/A'}%\n`;
  }

  if (metrics.seat_hold_successes) {
    out += `\n  Seat Hold Successes:    ${metrics.seat_hold_successes.values.count}\n`;
  }
  if (metrics.seat_hold_rejections) {
    out += `  Seat Hold Rejections:   ${metrics.seat_hold_rejections.values.count}\n`;
  }
  if (metrics.booking_created) {
    out += `  Bookings Created:       ${metrics.booking_created.values.count}\n`;
  }
  if (metrics.booking_rejected) {
    out += `  Bookings Rejected:      ${metrics.booking_rejected.values.count}\n`;
  }

  out += '═══════════════════════════════════════════════════════════\n';
  return out;
}
