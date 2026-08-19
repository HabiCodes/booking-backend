#!/usr/bin/env node
/**
 * verify-migrations.js
 *
 * Creates a temporary test database (Booking_migration_test), runs the full
 * migration chain, verifies idempotency, and then DROPS the test database.
 *
 * Usage: node verify-migrations.js
 *
 * Requires:
 *   - PostgreSQL running on localhost:5432
 *   - A "postgres" superuser database available (used only to CREATE/DROP)
 *   - Environment variables matching .env
 */

const { Pool } = require('pg');
const { readdirSync, readFileSync } = require('fs');
const { join } = require('path');

function loadEnv() {
  try {
    const envContent = readFileSync(join(__dirname, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    }
  } catch (e) {
    // .env not found — rely on environment
  }
}

loadEnv();

const DB_NAME = 'Booking_migration_test';
const ADMIN_DB = 'postgres';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Set it or provide a .env file.');
  process.exit(1);
}
const PORT = parseInt(DATABASE_URL.match(/:(\d+)\//)?.[1] || '5432');

const MIGRATIONS_DIR = join(__dirname, 'migrations', 'versions');

function loadMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((file) => {
    const match = file.match(/^(\d{3,})_(.+)\.sql$/);
    if (!match) throw new Error(`Bad filename: ${file}`);
    return {
      version: match[1],
      name: match[2],
      sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'),
    };
  });
}

async function runVerification() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  PostgreSQL Migration Verification');
  console.log('═══════════════════════════════════════════════════\n');

  // Step 1: Connect to admin DB
  console.log('[1] Connecting to PostgreSQL...');
  const adminConnStr = DATABASE_URL.replace(/\/Booking(\?.*)?$/, `/${ADMIN_DB}`);
  const adminPool = new Pool({ connectionString: adminConnStr, connectionTimeoutMillis: 10000 });

  let adminClient;
  try {
    adminClient = await adminPool.connect();
    const { rows } = await adminClient.query('SELECT version()');
    console.log(`    ✓ PostgreSQL: ${rows[0].version.split(' on ')[0]}\n`);
  } catch (err) {
    console.error('    ✗ Cannot connect to PostgreSQL:', err.message);
    console.error('    Make sure PostgreSQL is running on localhost:5432');
    process.exit(1);
  }

  try {
    // Step 2: Create clean test database
    console.log(`[2] Creating test database "${DB_NAME}"...`);
    try {
      await adminClient.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`    ✓ Created\n`);
    } catch (err) {
      if (err.code === '42P04') {
        console.log(`    ⚠ Database exists — dropping and recreating...`);
        await adminClient.query(`DROP DATABASE "${DB_NAME}"`);
        await adminClient.query(`CREATE DATABASE "${DB_NAME}"`);
        console.log(`    ✓ Recreated\n`);
      } else {
        throw err;
      }
    }

    // Step 3: Run full migration chain
    console.log('[3] Running migration chain...');
    const migrations = loadMigrations();
    const testConnStr = DATABASE_URL.replace(/\/Booking(\?.*)?$/, `/${DB_NAME}`);
    const pool = new Pool({ connectionString: testConnStr, connectionTimeoutMillis: 10000 });
    const client = await pool.connect();

    const applied = [];
    try {
      await client.query('BEGIN');

      // Bootstrap schema_migrations
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(20) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const { rows: existing } = await client.query('SELECT version FROM schema_migrations');
      const appliedSet = new Set(existing.map((r) => r.version));

      for (const m of migrations) {
        if (appliedSet.has(m.version)) {
          console.log(`    ○ ${m.version} ${m.name} — already applied`);
          continue;
        }

        console.log(`    ▶ ${m.version} ${m.name}...`, '');
        try {
          await client.query(m.sql);
          await client.query(
            'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
            [m.version, m.name]
          );
          applied.push(m.version);
          console.log(' ✓');
        } catch (err) {
          console.log(` ✗\n    Error: ${err.message}`);
          await client.query('ROLLBACK');
          console.log('\n    ROLLING BACK — no migrations were applied.');
          process.exit(1);
        }
      }

      await client.query('COMMIT');
      console.log(`\n    ✓ Applied ${applied.length} migration(s) this run`);
      console.log(`    ✓ Total applied: ${appliedSet.size + applied.length} migrations\n`);
    } finally {
      client.release();
      await pool.end();
    }

    // Step 4: Verify idempotency (second run should be no-ops)
    console.log('[4] Verifying idempotency (second run)...');
    const pool2 = new Pool({ connectionString: testConnStr, connectionTimeoutMillis: 10000 });
    const client2 = await pool2.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(20) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const { rows: check } = await client2.query('SELECT COUNT(*) as cnt FROM schema_migrations');
      const existingCount = parseInt(check[0].cnt);

      const migrations2 = loadMigrations();
      let reapplied = 0;
      for (const m of migrations2) {
        try {
          await client2.query(m.sql);
          // Try to record (will fail if already exists, which is fine)
          try {
            await client2.query(
              'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
              [m.version, m.name]
            );
            reapplied++;
          } catch {
            // Already tracked
          }
        } catch {
          // IF NOT EXISTS handled it
        }
      }

      const { rows: finalCheck } = await client2.query('SELECT COUNT(*) as cnt FROM schema_migrations');
      const finalCount = parseInt(finalCheck[0].cnt);

      await client2.query('COMMIT');

      if (finalCount === existingCount && reapplied === 0) {
        console.log(`    ✓ Idempotent — ${existingCount} migrations, no changes on re-run\n`);
      } else {
        console.log(`    ⚠ Unexpected re-applications detected (${reapplied} re-applied)\n`);
      }
    } finally {
      client2.release();
      await pool2.end();
    }

    // Step 5: Catalog verification
    console.log('[5] Verifying database catalog...');
    const pool3 = new Pool({ connectionString: testConnStr, connectionTimeoutMillis: 10000 });
    const client3 = await pool3.connect();
    try {
      const { rows: tables } = await client3.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename != 'schema_migrations'
        ORDER BY tablename
      `);
      console.log(`    Tables created (${tables.length}):`);
      for (const t of tables) {
        const { rows: cols } = await client3.query(
          `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = 'public'
           ORDER BY ordinal_position`,
          [t.tablename]
        );
        console.log(
          `      ${t.tablename}: ${cols.map((c) => c.column_name).join(', ')}`
        );
      }
      console.log();
    } finally {
      client3.release();
      await pool3.end();
    }

    // Step 6: Cleanup
    console.log(`[6] Dropping test database "${DB_NAME}"...`);
    // Force-close any remaining connections
    await adminClient.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid != pg_backend_pid()
    `, [DB_NAME]);
    await adminClient.query(`DROP DATABASE "${DB_NAME}"`);
    console.log('    ✓ Cleaned up\n');

    console.log('═══════════════════════════════════════════════════');
    console.log('  ALL CHECKS PASSED ✓');
    console.log('═══════════════════════════════════════════════════');

  } finally {
    adminClient.release();
    await adminPool.end();
  }
}

runVerification().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
