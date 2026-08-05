/**
 * Database Migration Runner
 *
 * Run with:  npm run db:migrate
 *
 * Applies the PostgreSQL schema defined in pool.ts
 * to the connected database. Safe to re-run (CREATE TABLE IF NOT EXISTS).
 *
 * Excluded from `tsc -p tsconfig.json` build (see tsconfig.json exclude).
 */
import { getPool, runMigrations, closePool } from '../db/pool';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  try {
    const pool = getPool();
    logger.info('Running PostgreSQL migrations...');
    await runMigrations();
    logger.info('All migrations applied successfully.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Migration failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
