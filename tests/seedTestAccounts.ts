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

async function seed(): Promise<void> {
  const pool = getPool();

  // 1. Admin (id=1) — required by adminAuthMiddleware
  await pool.query(
    `INSERT INTO admins (id, email, password_hash, name, role, is_active, permissions_updated_at)
     VALUES (1, 'admin@test.com', crypt('testpass123', gen_salt('bf')), 'Test Admin', 'super_admin', true, NOW())
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
  );

  // 2. Organization (id=1) — required by organizer_users FK
  await pool.query(
    `INSERT INTO organizations (id, name, display_name, slug, is_active)
     VALUES (1, 'Test Org', 'Test Organization', 'test-org', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
  );

  // 3. Organizer users (id=2,3) — required by organizerAuthMiddleware tests
  await pool.query(
    `INSERT INTO organizer_users (id, organization_id, email, password_hash, name, role, permissions, is_active)
     VALUES
       (2, 1, 'owner@test.com', crypt('testpass123', gen_salt('bf')), 'Test Owner', 'owner', '{}', true),
       (3, 1, 'org@example.com', crypt('testpass123', gen_salt('bf')), 'Test Org', 'owner', '{}', true)
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
  );

  await closePool();
}

seed().catch((err) => {
  console.error('Test seed failed:', err);
  process.exitCode = 1;
});
