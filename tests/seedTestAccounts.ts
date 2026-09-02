/**
 * Seed test auth accounts — idempotent.
 *
 * Ensures the database has admin/organizer records with is_active=true
 * at the IDs the auth middleware tests expect.
 *
 * Run automatically by the test setup, or manually:
 *   npx ts-node-dev --transpile-only tests/seedTestAccounts.ts
 */

import { getPool, closePool } from '../src/db/pool';

async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcrypt');
  return bcrypt.hash(password, 12);
}

async function seed(): Promise<void> {
  const pool = getPool();

  const adminHash = await hashPassword('testpass123');

  // 1. Admin (id=1) — required by adminAuthMiddleware
  await pool.query(
    `INSERT INTO admins (id, email, password_hash, name, role, is_active, permissions_updated_at)
     VALUES ($1, $2, $3, 'Test Admin', 'super_admin', true, NOW())
     ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, role = EXCLUDED.role`,
    [1, 'admin@test.com', adminHash],
  );

  // 1b. Customer user — required by authService tests (findByEmail)
  await pool.query(
    `INSERT INTO users (id, email, password_hash, is_verified, is_active)
     VALUES ($1, $2, $3, true, true)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [1, 'admin@test.com', adminHash],
  );

  // 2. Organization (id=1) — required by organizer_users FK
  await pool.query(
    `INSERT INTO organizations (id, name, display_name, slug, is_active)
     VALUES (1, 'Test Org', 'Test Organization', 'test-org', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
  );

  // 3. Organizer users (id=2,3) — required by organizerAuthMiddleware tests
  const orgHash = await hashPassword('testpass123');
  await pool.query(
    `INSERT INTO organizer_users (id, organization_id, email, password_hash, name, role, permissions, is_active)
     VALUES
       ($1, $2, $3, $4, 'Test Owner', 'owner', '{}', true),
       ($5, $2, $6, $7, 'Test Org', 'owner', '{}', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    [2, 1, 'owner@test.com', orgHash, 3, 'org@example.com', orgHash],
  );

  await closePool();
}

seed().catch((err) => {
  console.error('Test seed failed:', err);
  process.exitCode = 1;
});
