/**
 * Shared test helpers — database pool, server boot, and factory utilities.
 */

import { getPool, closePool } from '../../src/db/pool';

// ── Test database ──────────────────────────────────────────────────────────────

/**
 * Reset the test database to a clean state.
 * Runs all migration files and then seeds minimal data.
 * Call this in a beforeAll() block.
 */
export async function resetTestDatabase(): Promise<void> {
  const pool = getPool();
  // Drop all tables (CASCADE) and re-run migrations
  await pool.query(`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
  await import('../../src/db/migrations').then((m) => m.runMigrations());
}

/**
 * Close the DB pool after all tests.
 * Call this in an afterAll() block.
 */
export async function cleanupTestDatabase(): Promise<void> {
  await closePool();
}

// ── Admin JWT helper ───────────────────────────────────────────────────────────

import { generateAdminAccessToken } from '../../src/utils/jwt';

export function buildAdminToken(overrides?: {
  adminId?: number;
  email?: string;
  role?: string;
  permissions?: Record<string, boolean>;
}): string {
  return generateAdminAccessToken(
    overrides?.adminId ?? 1,
    overrides?.email ?? 'admin@test.com',
    overrides?.role ?? 'admin',
    overrides?.permissions ?? defaultPermissions(),
  );
}

export function defaultPermissions(): Record<string, boolean> {
  return {
    'users:read': true,
    'users:write': true,
    'users:delete': true,
    'events:read': true,
    'events:write': true,
    'events:delete': true,
    'events:publish': true,
    'events:feature': true,
    'bookings:read': true,
    'bookings:cancel': true,
    'bookings:delete': true,
    'banners:read': true,
    'banners:write': true,
    'banners:delete': true,
    'banners:activate': true,
    'uploads:read': true,
    'uploads:write': true,
    'uploads:delete': true,
    'scanner:verify': true,
    'scanner:checkin': true,
    'admins:read': true,
    'admins:write': true,
    'admins:delete': true,
    'audit:read': true,
    'analytics:read': true,
  };
}

// ── User JWT helper ────────────────────────────────────────────────────────────

import { generateAccessToken } from '../../src/utils/jwt';

export function buildUserToken(userId: number, email: string): string {
  return generateAccessToken(userId, email);
}
