/**
 * Migration runner — idempotent, production-grade.
 *
 * - Tracks applied migrations in `schema_migrations` table.
 * - Wraps each migration in a transaction (BEGIN/COMMIT/ROLLBACK).
 * - Uses PostgreSQL advisory lock to prevent concurrent migration execution
 *   across multiple API instances.
 * - Detects SQL error patterns in `existing column "remaining_capacity"` and
 *   similar ALTER TABLE conflicts; these are treated as no-ops.
 * - Files loaded from `migrations/versions/*.sql` in numeric order.
 *
 * Advisory lock strategy:
 *   pg_try_advisory_xact_lock() is non-blocking — it returns immediately
 *   with true/false. We retry with a short sleep until we acquire the lock
 *   or time out. This ensures:
 *   - Instance A starts migrations → acquires the lock
 *   - Instance B starts simultaneously → gets false → retries
 *   - Instance A finishes → releases the lock
 *   - Instance B acquires → runs migrations → all applied → no-op
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { Pool, PoolClient } from 'pg';
import { getPool } from './pool';
import { logger } from '../utils/logger';

const SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(20) PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

function advisoryLockId(text: string): bigint {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const chr = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return BigInt(hash & 0x7fffffff);
}

const HARMONIC_ERROR_PATTERNS = [
  /existing column/i,
  /duplicate column/i,
  /already exists/i,
  /duplicate key value violates unique constraint/i,
  /index ".*" already exists/i,
  /constraint .* already exists/i,
];

function resolveMigrationsDir(): string {
  const candidates = [
    join(process.cwd(), 'migrations', 'versions'),
    join(process.cwd(), '..', 'migrations', 'versions'),
    join(dirname(__dirname), '..', 'migrations', 'versions'),
  ];

  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      // continue
    }
  }

  throw new Error('Cannot locate migrations/versions directory');
}

function loadMigrations(dir: string): { version: string; name: string; sql: string }[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((file) => {
    const match = file.match(/^(\d{3,})_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Migration file "${file}" must match pattern NNN_name.sql`);
    }
    const version = match[1]!;
    const name = match[2]!;
    const sql = readFileSync(join(dir, file), 'utf-8');
    return { version, name, sql };
  });
}

export async function runMigrations(): Promise<string[]> {
  const pool = getPool();
  const applied: string[] = [];

  const MAX_LOCK_WAIT_MS = 30_000;
  const LOCK_RETRY_MS = 250;
  const lockId = advisoryLockId('entrymyslot_migrations');
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();

    // ── Retry loop for advisory lock acquisition ─────────────────────────────
    const lockStart = Date.now();
    let lockAcquired = false;

    while (Date.now() - lockStart < MAX_LOCK_WAIT_MS) {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT pg_try_advisory_xact_lock(${lockId.toString()}) AS acquired`
      );
      lockAcquired = rows[0]?.acquired === true;

      if (lockAcquired) break;

      // Lock not acquired — rollback, release client, wait, get new client
      await client.query('ROLLBACK');
      client.release();
      client = null;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
      client = await pool.connect();
    }

    if (!lockAcquired) {
      logger.error('[Migrations] Could not acquire advisory lock within 30s — another instance is migrating. This instance cannot safely serve traffic.');
      if (client) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
      }
      throw new Error('Migration advisory lock timeout — another instance is running migrations. Startup cannot proceed safely.');
    }

    logger.info('[Migrations] Advisory lock acquired — proceeding with migration check');

    await client.query(SCHEMA_MIGRATIONS_TABLE);

    const { rows: appliedRows } = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedSet = new Set(appliedRows.map((r) => r.version));

    const dir = resolveMigrationsDir();
    const migrations = loadMigrations(dir);

    for (const m of migrations) {
      if (appliedSet.has(m.version)) {
        logger.debug(`Migration ${m.version} (${m.name}) — already applied`);
        continue;
      }

      logger.info(`Applying migration ${m.version} (${m.name})…`);

      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          m.version,
          m.name,
        ]);
        applied.push(m.version);
        logger.info(`Migration ${m.version} applied`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isHarmonic = HARMONIC_ERROR_PATTERNS.some((p) => p.test(errorMessage));

        if (isHarmonic) {
          logger.warn(
            `Migration ${m.version} hit an expected conflict (likely already applied via another path): ${errorMessage}. Recording as applied.`
          );
          try {
            await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
              m.version,
              m.name,
            ]);
            applied.push(m.version);
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
    }

    if (applied.length === 0) {
      logger.info('No pending migrations');
    } else {
      logger.info(`Applied ${applied.length} migration(s) this run`);
    }

    await client.query('COMMIT');
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    logger.error('Migration runner failed:', err as Error);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }

  return applied;
}
