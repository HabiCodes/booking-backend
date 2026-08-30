#!/usr/bin/env node
/**
 * Node.js HTTP Load Tester — zero dependencies.
 * Uses built-in http, https, perf_hooks modules only.
 *
 * Usage:
 *   BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs discovery 100 60
 *   BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs seatMap 500 30
 *   BASE_URL=http://localhost:4000 node tests/load/runLoadTest.mjs seatCompetition 500 30
 *
 * Environment Variables:
 *   BASE_URL           — Server base URL (default: http://localhost:4000)
 *   TEST_USER_TOKEN    — JWT bearer token for authenticated requests
 *   MOVIE_ID           — Movie ID for discovery tests
 *   CINEMA_ID          — Cinema ID for discovery tests
 *   SHOWTIME_ID        — Showtime ID for seat/booking tests
 *   SCREEN_ID          — Screen ID for seat layout tests
 */

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { argv, env, stdout, exit, stderr } from 'node:process';

const BASE_URL = env.BASE_URL || 'http://localhost:4000';
const TEST_USER_TOKEN = env.TEST_USER_TOKEN || '';
const MOVIE_ID = env.MOVIE_ID || '1';
const CINEMA_ID = env.CINEMA_ID || '1';
const SHOWTIME_ID = env.SHOWTIME_ID || '1';
const SCREEN_ID = env.SCREEN_ID || '1';

const SCENARIO = argv[2] || 'discovery';
const USERS = parseInt(argv[3] || '100', 10);
const DURATION_SEC = parseInt(argv[4] || '30', 10);

// ── HTTP Helper ─────────────────────────────────────────────────────────────

function httpRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(BASE_URL); } catch { reject(new Error('Invalid BASE_URL')); return; }
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'MovieLoadTester/1.0',
        'Connection': 'keep-alive',
        ...(TEST_USER_TOKEN ? { Authorization: `Bearer ${TEST_USER_TOKEN}` } : {}),
        ...headers,
      },
    };

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try { parsedBody = JSON.parse(data); } catch { parsedBody = data; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsedBody });
      });
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout (30s)'));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Percentile ──────────────────────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.floor((p / 100) * sortedArr.length);
  return sortedArr[Math.min(idx, sortedArr.length - 1)];
}

// ── Scenario Functions ──────────────────────────────────────────────────────

const scenarios = {
  // Scenario A: Movie Discovery (read-heavy, public)
  async discovery() {
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
    return await httpRequest(ep.method, ep.path);
  },

  // Scenario B: Hot Showtime Seat Map (read-heavy, single showtime)
  async seatMap() {
    return await httpRequest('GET', `/api/v1/showtimes/${SHOWTIME_ID}/seats`);
  },

  // Scenario C: Seat Competition (writes, same seats)
  async seatCompetition() {
    // Each user attempts to hold 5 seats starting at seat 1
    const seatIds = [1, 2, 3, 4, 5];
    return await httpRequest('POST', '/api/v1/hold-seats', { showtimeId: parseInt(SHOWTIME_ID), seatIds });
  },

  // Scenario D: 10-Ticket Limit (boundary test)
  async tenTicketLimit() {
    const variants = [
      { count: 1 },
      { count: 5 },
      { count: 10 },
      { count: 11 },
      { count: 20 },
    ];
    const v = variants[Math.floor(Math.random() * variants.length)];
    const seatIds = Array.from({ length: v.count }, (_, i) => i + 1);
    return await httpRequest('POST', '/api/v1/hold-seats', { showtimeId: parseInt(SHOWTIME_ID), seatIds });
  },

  // Scenario E: Booking Creation Stress
  async bookingStress() {
    // First hold seats
    const seatIds = Array.from({ length: 5 }, (_, i) => 100 + i + Math.floor(Math.random() * 50));
    const holdRes = await httpRequest('POST', '/api/v1/hold-seats', { showtimeId: parseInt(SHOWTIME_ID), seatIds });
    if (holdRes.status !== 200) return holdRes;
    return await httpRequest('POST', '/api/v1/bookings', {
      holdKey: holdRes.body.data.holdKey,
      idempotencyKey: `loadtest_${Date.now()}_${Math.random()}`,
      customerEmail: 'loadtest@example.com',
      customerPhone: '+919999999999',
      customerName: 'Load Tester',
    });
  },
};

// ── Run Scenario ────────────────────────────────────────────────────────────

async function runScenario(name) {
  const fn = scenarios[name];
  if (!fn) {
    stderr.write(`Unknown scenario: ${name}\nAvailable: ${Object.keys(scenarios).join(', ')}\n`);
    exit(1);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SCENARIO: ${name}`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Concurrent workers: ${USERS} (50 actual connections, ${USERS} VU simulation)`);
  console.log(`  Duration: ${DURATION_SEC}s`);
  console.log(`${'═'.repeat(70)}`);

  const results = [];
  const startTime = performance.now();
  const endTime = startTime + DURATION_SEC * 1000;

  // Run actual concurrent workers (cap at 50 concurrent connections)
  const actualWorkers = Math.min(USERS, 50);
  const workerPromises = [];

  for (let i = 0; i < actualWorkers; i++) {
    workerPromises.push(runWorker(i, endTime, fn, results));
  }

  // Progress reporter
  const progressInterval = setInterval(() => {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const completed = results.length;
    const errors = results.filter(r => r.error).length;
    const avgLatency = results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.latency, 0) / results.length)
      : 0;
    stdout.write(`\r  [${elapsed}s/${DURATION_SEC}s] Requests: ${completed} | Errors: ${errors} | Avg Latency: ${avgLatency}ms   `);
  }, 2000);

  await Promise.all(workerPromises);
  clearInterval(progressInterval);
  console.log('');

  return analyzeAndPrint(results, name);
}

async function runWorker(id, endTime, fn, results) {
  while (performance.now() < endTime) {
    const t0 = performance.now();
    try {
      const result = await fn();
      results.push({
        workerId: id,
        latency: Math.round(performance.now() - t0),
        status: result.status,
        error: null,
        bodySize: JSON.stringify(result.body || '').length,
      });
    } catch (err) {
      results.push({
        workerId: id,
        latency: Math.round(performance.now() - t0),
        status: 0,
        error: err.message,
        bodySize: 0,
      });
    }
    // No artificial delay - real concurrent load
    await new Promise(r => setImmediate(r));
  }
}

function analyzeAndPrint(results, scenarioName) {
  const total = results.length;
  const errors = results.filter(r => r.error);
  const successes = results.filter(r => !r.error);
  const latencies = results.map(r => r.latency).sort((a, b) => a - b);
  const statusCodes = {};
  for (const r of results) {
    if (r.status) statusCodes[r.status] = (statusCodes[r.status] || 0) + 1;
  }
  const elapsedSec = total > 1 ? (results[results.length - 1].latency / 1000) : DURATION_SEC;
  const rps = total > 0 ? (total / elapsedSec).toFixed(1) : 0;

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const maxLat = latencies[latencies.length - 1] || 0;
  const avgBodySize = results.length > 0
    ? Math.round(results.reduce((s, r) => s + (r.bodySize || 0), 0) / results.length)
    : 0;

  const report = {
    scenario: scenarioName,
    timestamp: new Date().toISOString(),
    duration_sec: DURATION_SEC,
    concurrent_workers: Math.min(USERS, 50),
    total_requests: total,
    successes: successes.length,
    errors: errors.length,
    error_rate: total > 0 ? +(errors.length / total * 100).toFixed(2) : 0,
    rps: +rps,
    latency_ms: { p50, p95, p99, max: maxLat },
    status_codes: statusCodes,
    avg_response_size_bytes: avgBodySize,
    sample_errors: errors.slice(0, 3).map(e => e.error),
  };

  console.log(`\n  ┌─ Results ──────────────────────────────────────────`);
  console.log(`  │ Total Requests:    ${total}`);
  console.log(`  │ Successes:         ${successes.length}`);
  console.log(`  │ Errors:            ${errors.length}`);
  console.log(`  │ Error Rate:        ${report.error_rate}%`);
  console.log(`  │ RPS:               ${rps}`);
  console.log(`  │ p50 Latency:       ${p50}ms`);
  console.log(`  │ p95 Latency:       ${p95}ms`);
  console.log(`  │ p99 Latency:       ${p99}ms`);
  console.log(`  │ Max Latency:       ${maxLat}ms`);
  console.log(`  │ Avg Response Size: ${avgBodySize} bytes`);
  if (Object.keys(statusCodes).length > 0) {
    console.log(`  │ Status Codes:`);
    for (const [code, count] of Object.entries(statusCodes)) {
      console.log(`  │   ${code}: ${count}`);
    }
  }
  if (errors.length > 0 && errors.length <= 5) {
    console.log(`  │ Error Samples:`);
    for (const e of errors.slice(0, 3)) {
      console.log(`  │   - ${e.error}`);
    }
  }
  console.log(`  └─────────────────────────────────────────────────────`);
  console.log('');

  // Emit JSON for downstream parsing
  stdout.write(`\n__LOAD_TEST_JSON__:${JSON.stringify(report)}\n`);
  return report;
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('Movie Booking Load Tester — Node.js v' + process.version);
  console.log('  ' + new Date().toISOString());

  const allScenarios = process.env.SCENARIO === 'all' || SCENARIO === 'all';
  if (allScenarios) {
    for (const name of ['discovery', 'seatMap', 'tenTicketLimit', 'seatCompetition']) {
      await runScenario(name);
    }
  } else {
    await runScenario(SCENARIO);
  }

  exit(0);
})();
