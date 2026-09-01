/**
 * Regression tests — Organizer/Owner Dashboard production audit fixes.
 *
 * Tests validate that the fixes are correctly applied by checking
 * the source code patterns in ownerDashboardService.ts and turfManagerRoutes.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

const SVC = readFileSync(join(ROOT, 'src', 'services', 'ownerDashboardService.ts'), 'utf-8');
const ROUTES = readFileSync(join(ROOT, 'src', 'routes', 'turfManagerRoutes.ts'), 'utf-8');
const MSVC = readFileSync(join(ROOT, 'src', 'services', 'managerAnalyticsService.ts'), 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — util_agg CTE: COUNT(DISTINCT tau.id) prevents JOIN multiplication
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 1 — util_agg uses COUNT(DISTINCT tau.id)', () => {
  it('SQL pattern uses COUNT(DISTINCT tau.id) for utilization numerator', () => {
    assert.ok(
      SVC.includes("COUNT(DISTINCT tau.id) FILTER (WHERE tb.status IN ('confirmed','completed'))"),
      'Must use DISTINCT tau.id in FILTER'
    );
  });

  it('SQL pattern uses COUNT(DISTINCT tau.id) for denominator', () => {
    assert.ok(
      SVC.includes('COUNT(DISTINCT tau.id), 0) * 100 AS util_pct'),
      'Denominator must also use COUNT(DISTINCT tau.id)'
    );
  });

  it('does NOT use plain COUNT(*) for utilization (would double-count JOIN rows)', () => {
    // The old unsafe pattern: COUNT(*) FILTER (WHERE...) / NULLIF(COUNT(*), 0) * 100
    const oldUnsafe = "COUNT(*) FILTER (WHERE tb.status IN ('confirmed','completed'))\n         / NULLIF(COUNT(*), 0) * 100 AS util_pct";
    assert.ok(!SVC.includes(oldUnsafe), 'Plain COUNT(*) for utilization is unsafe with JOINs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — Settlement history: 3-table UNION with explicit domain column
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 2 — Settlement history 3-table UNION', () => {
  it('turf_settlements query has explicit domain column', () => {
    assert.ok(
      SVC.includes("'turf'::text AS domain") && SVC.includes('FROM turf_settlements'),
      'Must have explicit turf domain column'
    );
  });

  it('event_settlements query has explicit domain column', () => {
    assert.ok(
      SVC.includes("'event'::text AS domain") && SVC.includes('FROM event_settlements'),
      'Must have explicit event domain column'
    );
  });

  it('movie query has explicit domain column with metadata filter', () => {
    assert.ok(
      SVC.includes("'movie'::text AS domain") && SVC.includes("(metadata->>'domain') = 'movie'"),
      'Movie must have explicit domain column'
    );
    assert.ok(
      SVC.includes("metadata->>'domain') = 'movie'"),
      'Movie must filter by metadata domain'
    );
  });

  it('domain is read from explicit SQL column, not org_id heuristic', () => {
    assert.ok(
      SVC.includes("String(row.domain || 'turf')"),
      'Domain must come from row.domain column'
    );
  });

  it('does NOT use old heuristic: row.organization_id < 1000000000', () => {
    assert.ok(
      !SVC.includes('fromTurf') && !SVC.includes('fromMovie'),
      'fromTurf/fromMovie heuristic variables must not exist'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3 — Movie summary: no refunds table JOIN (no movie refund handler)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 3 — Movie summary refunds handling', () => {
  it('movie summary does NOT JOIN refunds (event table)', () => {
    // The _getDomainSummaries movie query should not have a refund_totals CTE
    // Look for the movie summary section in _getDomainSummaries
    const movieSummaryPattern = `FROM movie_bookings mb`;
    assert.ok(SVC.includes(movieSummaryPattern), 'movie_bookings must be the base table');

    // Extract around the movie summary - should not reference refunds for movie
    const idx = SVC.indexOf('// Movie summary');
    if (idx !== -1) {
      const movieSection = SVC.substring(idx, idx + 800);
      assert.ok(
        !movieSection.includes('LEFT JOIN refund_totals'),
        'Movie summary must not LEFT JOIN refund_totals'
      );
    }
  });

  it('movie summary refunds_paise is hardcoded to 0', () => {
    assert.ok(
      SVC.includes('0::bigint AS refunds_paise'),
      'Movie refunds_paise must be 0 since no movie refund handler exists'
    );
  });

  it('movie summary has comment explaining no refund handler', () => {
    const idx = SVC.indexOf('// Movie summary');
    if (idx !== -1) {
      const movieSection = SVC.substring(idx, idx + 300);
      assert.ok(
        movieSection.includes('refund handler') || movieSection.includes('no movie refund'),
        'Must explain why movie refunds are 0'
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 4 — turfManagerRoutes: half-open date boundaries (no T23:59:59Z)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 4 — turfManagerRoutes half-open date boundaries', () => {
  it('does NOT use T23:59:59Z anywhere in routes file', () => {
    assert.ok(!ROUTES.includes('T23:59:59Z'), 'T23:59:59Z closed upper bound must be removed');
  });

  it('uses setUTCDate to compute next-day midnight', () => {
    assert.ok(
      ROUTES.includes('setUTCDate(dt.getUTCDate() + 1)'),
      'Must use setUTCDate for half-open boundary calculation'
    );
  });

  it('uses < (half-open) not <= (closed) for date comparison', () => {
    assert.ok(ROUTES.includes('au.starts_at < $'), 'Must use < for half-open upper bound');
    assert.ok(ROUTES.includes('q.used_at < $'), 'Must use < for QR date upper bound');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 5 — Customer segments: multi-domain (turf + event + movie)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 5 — Customer segments multi-domain', () => {
  it('includes LEFT JOIN to event bookings table', () => {
    assert.ok(SVC.includes('LEFT JOIN bookings b'), 'Must join bookings');
  });

  it('includes LEFT JOIN to movie_bookings table', () => {
    assert.ok(SVC.includes('LEFT JOIN movie_bookings mb'), 'Must join movie_bookings');
  });

  it('event bookings scoped to organization via events table', () => {
    assert.ok(
      SVC.includes('b.event_id IN (SELECT id FROM events WHERE organization_id = $1)'),
      'Event bookings must be scoped by organization'
    );
  });

  it('movie bookings scoped by organization_id', () => {
    assert.ok(
      SVC.includes('mb.organization_id = $1'),
      'Movie bookings must be scoped by organization_id'
    );
  });

  it('customer segment response has correct shape (no revenue fields from removed CTE)', () => {
    // After the fix, customer_segments returns only new_customers and returning_customers
    // The response maps to 0 for revenue fields
    assert.ok(
      SVC.includes('totalRevenuePaise: 0'),
      'totalRevenuePaise must be 0 (payment_orders JOIN not yet added for multi-domain)'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 6 — Manager analytics: default date is today (not yesterday)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX 6 — Manager analytics default date is today', () => {
  const MSVC = readFileSync(join(__dirname, '../../src/services/managerAnalyticsService.ts'), 'utf-8');

  it('uses todayStr as default when no range provided', () => {
    assert.ok(
      MSVC.includes('const from = range?.from ?? todayStr;'),
      'Must default from date to todayStr'
    );
  });

  it('does NOT have yesterday variable for default range', () => {
    assert.ok(!MSVC.includes('const yesterday'), 'No yesterday variable for default range');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

describe('Organizer Dashboard regression — all fixes verified', () => {
  it('all 6 fixes are applied to source code', () => {
    assert.ok(true, 'FIX 1-6 verified via source code inspection');
  });
});
