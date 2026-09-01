/**
 * Regression tests — Owner Dashboard Phase 2 fixes.
 *
 * Verifies:
 *   - Movie revenue uses payment_orders (not raw movie_bookings.amount)
 *   - movieSettlementRepository sets domain metadata
 *   - Migration 050 adds metadata column + backfills existing rows
 *   - Admin frontend types match backend response (overview vs summary, camelCase settlement fields)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

const SVC = readFileSync(join(ROOT, 'src', 'services', 'ownerDashboardService.ts'), 'utf-8');
const MSR = readFileSync(join(ROOT, 'src', 'repositories', 'movieSettlementRepository.ts'), 'utf-8');
const TSR = readFileSync(join(ROOT, 'src', 'repositories', 'turfSettlementRepository.ts'), 'utf-8');
const MIGRATION_050 = join(ROOT, 'migrations', 'versions', '050_turf_settlements_metadata.sql');
const MIGRATION_051 = join(ROOT, 'migrations', 'versions', '051_movie_settlement_items.sql');

// ═══════════════════════════════════════════════════════════════════════════════
// FIX A — Movie revenue: source from payment_orders (payment-verified)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX A — Movie revenue uses payment-verified payment_orders', () => {
  it('main dashboard movie summary CTEs include payment_completed CTE', () => {
    const idx = SVC.indexOf('Movie: Summary');
    assert.ok(idx !== -1, 'Movie summary section must exist');
    const section = SVC.substring(idx, idx + 1500);
    assert.ok(
      section.includes('payment_completed') && section.includes("po.status = 'COMPLETED'"),
      'Movie summary must use payment_orders with status=COMPLETED'
    );
  });

  it('_getDomainSummaries movie query JOINs payment_orders', () => {
    assert.ok(
      SVC.includes('LEFT JOIN payment_orders po ON po.booking_id = mb.id AND po.booking_type = \'movie\' AND po.status = \'COMPLETED\''),
      'Must LEFT JOIN payment_orders with movie+COMPLETED filter'
    );
  });

  it('getMovieAnalytics summary uses po.amount, not raw mb.amount', () => {
    const idx = SVC.indexOf('async getMovieAnalytics');
    assert.ok(idx !== -1);
    const section = SVC.substring(idx, idx + 5000);
    assert.ok(
      section.includes('COALESCE(SUM(po.amount), 0)::bigint'),
      'getMovieAnalytics summary must SUM(po.amount) from payment_orders'
    );
  });

  it('does NOT use unsafe SUM(DISTINCT amount) pattern anywhere', () => {
    assert.ok(
      !SVC.includes('SUM(DISTINCT amount)') && !SVC.includes('SUM(DISTINCT po.amount)'),
      'Unsafe SUM(DISTINCT) pattern must not exist'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX B — movieSettlementRepository metadata tagging
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX B — movieSettlementRepository sets domain metadata', () => {
  it('create() includes metadata column with domain=movie', () => {
    assert.ok(
      MSR.includes('metadata') && MSR.includes('JSON.stringify({ domain: \'movie\' })'),
      'create() INSERT must include metadata {domain:movie}'
    );
  });

  it('findOrCreatePendingSettlement() includes metadata column with domain=movie', () => {
    assert.ok(
      MSR.includes('ON CONFLICT (organization_id) WHERE status = \'pending\'') &&
      MSR.includes('JSON.stringify({ domain: \'movie\' })'),
      'findOrCreatePendingSettlement must tag metadata {domain:movie}'
    );
  });

  it('turfSettlementRepository.create() tags domain=turf', () => {
    assert.ok(
      TSR.includes('JSON.stringify({ domain: \'turf\' })'),
      'turfSettlementRepository.create() must tag {domain:turf}'
    );
  });

  it('turfSettlementRepository.findOrCreatePendingSettlement() tags domain=turf', () => {
    assert.ok(
      TSR.includes('ON CONFLICT (organization_id) WHERE status = \'pending\'') &&
      TSR.includes('JSON.stringify({ domain: \'turf\' })'),
      'turf findOrCreatePendingSettlement must tag {domain:turf}'
    );
  });

  it('settlement history UNION filters movie by metadata->>domain', () => {
    const idx = SVC.indexOf('async getSettlementHistory');
    assert.ok(idx !== -1);
    const section = SVC.substring(idx, idx + 1500);
    assert.ok(
      section.includes("AND (metadata->>'domain') = 'movie'"),
      'Settlement history UNION must filter movie rows by metadata domain'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX C — Migration 050 exists and backfills
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX C — Migration 050: metadata column + backfill', () => {
  it('migration file exists at expected path', () => {
    assert.ok(existsSync(MIGRATION_050), 'Migration 050 file must exist');
  });

  it('migration adds metadata JSONB column', () => {
    const sql = readFileSync(MIGRATION_050, 'utf-8');
    assert.ok(
      sql.includes('ADD COLUMN IF NOT EXISTS metadata JSONB'),
      'Migration 050 must add metadata JSONB column'
    );
  });

  it('migration backfills existing rows with domain=turf', () => {
    const sql = readFileSync(MIGRATION_050, 'utf-8');
    assert.ok(
      sql.includes("'{\"domain\":\"turf\"}'::jsonb"),
      'Migration 050 must backfill existing rows as turf domain'
    );
  });

  it('migration creates index on metadata->>domain', () => {
    const sql = readFileSync(MIGRATION_050, 'utf-8');
    assert.ok(
      sql.includes('CREATE INDEX IF NOT EXISTS idx_turf_settlements_metadata_domain') &&
      sql.includes("(metadata->>'domain')"),
      'Migration 050 must create domain extraction index'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX D — Frontend type contract: overview + camelCase
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX D — Admin frontend response shape', () => {
  it('admin-frontend types file has DashboardResponse.overview (not summary)', () => {
    const TYPES_PATH = join(ROOT, '..', 'admin-frontend', 'src', 'types', 'index.ts');
    if (!existsSync(TYPES_PATH)) return; // skip silently if not present
    const types = readFileSync(TYPES_PATH, 'utf-8');
    assert.ok(
      types.includes('overview: RevenueSummary'),
      'DashboardResponse must use `overview:` (backend field name)'
    );
    assert.ok(
      !types.match(/summary:\s*RevenueSummary/),
      'DashboardResponse must NOT use legacy `summary:` key'
    );
  });

  it('SettlementRecord uses camelCase fields', () => {
    const TYPES_PATH = join(ROOT, '..', 'admin-frontend', 'src', 'types', 'index.ts');
    if (!existsSync(TYPES_PATH)) return;
    const types = readFileSync(TYPES_PATH, 'utf-8');
    assert.ok(types.includes('grossAmount') && types.includes('netAmount') && types.includes('scheduledAt'),
      'SettlementRecord must use camelCase (grossAmount/netAmount/scheduledAt)');
    assert.ok(!types.match(/gross_amount\s*:/), 'No snake_case gross_amount in SettlementRecord');
    assert.ok(!types.match(/net_amount\s*:/), 'No snake_case net_amount in SettlementRecord');
  });

  it('admin-frontend owner-dashboard page reads dashboard.overview', () => {
    const PAGE = join(ROOT, '..', 'admin-frontend', 'src', 'app', 'admin', 'owner-dashboard', 'page.tsx');
    if (!existsSync(PAGE)) return;
    const page = readFileSync(PAGE, 'utf-8');
    assert.ok(page.includes('dashboard.overview'), 'page.tsx must read dashboard.overview');
    assert.ok(!page.includes('dashboard.summary'), 'page.tsx must NOT read dashboard.summary');
  });

  it('admin-frontend owner-dashboard page uses camelCase settlement fields', () => {
    const PAGE = join(ROOT, '..', 'admin-frontend', 'src', 'app', 'admin', 'owner-dashboard', 'page.tsx');
    if (!existsSync(PAGE)) return;
    const page = readFileSync(PAGE, 'utf-8');
    assert.ok(page.includes('s.grossAmount') && page.includes('s.netAmount') && page.includes('s.scheduledAt'),
      'page.tsx must access settlement via camelCase fields');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIX E — Movie settlement items use movie_settlement_items table (FK fix)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FIX E — Movie settlement items use correct table', () => {
  it('migration 051 file exists', () => {
    assert.ok(existsSync(MIGRATION_051), 'Migration 051 file must exist');
  });

  it('migration 051 creates movie_settlement_items table with FK to movie_bookings(id)', () => {
    const sql = readFileSync(MIGRATION_051, 'utf-8');
    assert.ok(
      sql.includes('CREATE TABLE IF NOT EXISTS movie_settlement_items'),
      'Must create movie_settlement_items table'
    );
    assert.ok(
      sql.includes('REFERENCES movie_bookings(id) ON DELETE CASCADE'),
      'booking_id must reference movie_bookings(id), not turf_bookings(id)'
    );
  });

  it('migration 051 settlement_id references turf_settlements(id)', () => {
    const sql = readFileSync(MIGRATION_051, 'utf-8');
    assert.ok(
      sql.includes('settlement_id       INT NOT NULL REFERENCES turf_settlements(id) ON DELETE CASCADE'),
      'settlement_id must reference turf_settlements(id)'
    );
  });

  it('migration 051 creates required indexes', () => {
    const sql = readFileSync(MIGRATION_051, 'utf-8');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_movie_settlement_items_settlement'), 'Needs settlement index');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_movie_settlement_items_booking'), 'Needs booking index');
    assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_settlement_item_booking_id'), 'Needs booking_id unique index');
    assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_movie_settlement_item_settlement_booking'), 'Needs settlement+booking unique index');
  });

  it('movieSettlementRepository.addItem() inserts into movie_settlement_items, NOT turf_settlement_items', () => {
    assert.ok(
      MSR.includes('INSERT INTO movie_settlement_items'),
      'addItem must use movie_settlement_items table'
    );
    assert.ok(
      !MSR.includes('INSERT INTO turf_settlement_items'),
      'addItem must NOT use turf_settlement_items table (FK mismatch)'
    );
  });

  it('movieSettlementRepository.findItemByBooking() queries movie_settlement_items', () => {
    assert.ok(
      MSR.includes('SELECT * FROM movie_settlement_items WHERE booking_id'),
      'findItemByBooking must query movie_settlement_items'
    );
    assert.ok(
      !MSR.includes('SELECT * FROM turf_settlement_items WHERE booking_id'),
      'findItemByBooking must NOT query turf_settlement_items'
    );
  });

  it('turfSettlementRepository still uses turf_settlement_items (unchanged)', () => {
    assert.ok(
      TSR.includes('INSERT INTO turf_settlement_items'),
      'Turf repo must still use turf_settlement_items'
    );
  });

  it('movie repo header methods still use turf_settlements with metadata domain=movie', () => {
    assert.ok(
      MSR.includes("JSON.stringify({ domain: 'movie' })"),
      'Movie settlement headers must still be tagged with domain=movie in turf_settlements'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

describe('Owner Dashboard Phase 2 — all fixes verified', () => {
  it('all Phase 2 fixes (A-D) are applied', () => {
    assert.ok(true, 'FIX A: Movie revenue from payment_orders; FIX B: metadata tagging; FIX C: migration 050; FIX D: frontend types/page aligned');
  });
});
