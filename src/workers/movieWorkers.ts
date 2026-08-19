/**
 * Movie Workers — background jobs for movie booking expiration.
 *
 * Run via: node dist/workers/movieWorkers.js
 * Or schedule via cron (every 5 min): node dist/workers/movieWorkers.js expire
 */

import { movieBookingService } from '../services/movieBookingService';
import { logger } from '../utils/logger';
import { getPool, closePool } from '../db/pool';

type WorkerJob = 'expire' | 'all';

// ── Workers ────────────────────────────────────────────────────────────────────

async function expireStaleBookings() {
  try {
    const count = await movieBookingService.expireStaleBookings();
    logger.info(`[MovieWorker] expireStaleBookings done: ${count} expired`);
  } catch (err) {
    logger.error('[MovieWorker] expireStaleBookings failed:', err);
  }
}

// ── Entry Point ────────────────────────────────────────────────────────────────

async function main() {
  const job = (process.argv[2] || 'all') as WorkerJob;
  logger.info(`[MovieWorker] Starting job: ${job}`);

  try {
    if (job === 'expire' || job === 'all') {
      await expireStaleBookings();
    }

    logger.info(`[MovieWorker] Job ${job} completed`);
  } catch (err) {
    logger.error(`[MovieWorker] Job ${job} failed:`, err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
