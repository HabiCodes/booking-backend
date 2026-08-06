/**
 * Database Migration Runner — CLI entrypoint
 *
 * Run with:  npm run db:migrate
 *
 * Applies all pending migrations from migrations/versions/*.sql
 * Idempotent — re-running is a no-op once everything is current.
 *
 * Excluded from `tsc -p tsconfig.json` build (see tsconfig.json exclude).
 */

import { getPool, closePool } from './pool';
import { runMigrations } from './migrations';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  try {
    const pool = getPool();
    // Force pool init by issuing a no-op query
    await pool.query('SELECT 1');
    logger.info('Running PostgreSQL migrations…');
    const applied = await runMigrations();
    logger.info(`Migrations complete — ${applied.length} applied this run.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
