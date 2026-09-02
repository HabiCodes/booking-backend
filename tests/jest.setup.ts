/**
 * Global test setup / teardown.
 * Sets NODE_ENV to 'test' so the app loads test-safe config.
 * Seeds minimal admin + organizer records needed by auth middleware tests.
 */

process.env.NODE_ENV = 'test';

// Suppress noisy file transports during tests
process.env.LOG_FILE_ENABLED = 'false';

// ── Seed test auth accounts ────────────────────────────────────────────────────

import { getPool, closePool } from '../src/db/pool';

async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcrypt');
  return bcrypt.hash(password, 12);
}

async function seedTestAccounts(): Promise<void> {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');

    const adminHash = await hashPassword('testpass123');

    // 1. Seed admin record (id=1) — required by adminAuthMiddleware tests
    await pool.query(
      `INSERT INTO admins (id, email, password_hash, name, role, is_active, permissions_updated_at)
       VALUES ($1, $2, $3, 'Test Admin', 'super_admin', true, NOW())
       ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, role = EXCLUDED.role`,
      [1, 'admin@test.com', adminHash],
    );

    // 2. Seed organization (id=1) — required by organizer_users FK
    await pool.query(
      `INSERT INTO organizations (id, name, display_name, slug, is_active)
       VALUES (1, 'Test Org', 'Test Organization', 'test-org', true)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
    );

    // 2b. Seed customer user (id=1) — required by authService tests (findByEmail)
    await pool.query(
      `INSERT INTO users (id, email, password_hash, is_verified, is_active)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [1, 'admin@test.com', adminHash],
    );

    // 3. Seed organizer users (id=2,3) — required by organizerAuthMiddleware tests
    const orgHash = await hashPassword('testpass123');
    await pool.query(
      `INSERT INTO organizer_users (id, organization_id, email, password_hash, name, role, permissions, is_active)
       VALUES
         ($1, $2, $3, $4, 'Test Owner', 'owner', '{}', true),
         ($5, $2, $6, $7, 'Test Org', 'owner', '{}', true)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [2, 1, 'owner@test.com', orgHash, 3, 'org@example.com', orgHash],
    );
  } catch {
    // Best-effort: if seeding fails, tests that need DB-backed auth will fail
    // with 401 (not crash), which is acceptable for test infrastructure.
  }
}

seedTestAccounts().catch(() => {});
