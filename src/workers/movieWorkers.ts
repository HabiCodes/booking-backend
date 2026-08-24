/**
 * Movie Workers — background jobs for movie booking expiration.
 *
 * Exported functions can be called directly (no process.exit).
 * The `runMovieWorkers()` wrapper handles startup logging.
 */

import { movieBookingService } from '../services/movieBookingService';
import { logger } from '../utils/logger';
import { getRedis } from '../db/redis';

export type MovieWorkerJob = 'expire' | 'expire-holds' | 'all';

// ── Workers ────────────────────────────────────────────────────────────────────

export async function expireStaleMovieBookings(): Promise<number> {
  return movieBookingService.expireStaleBookings();
}

/**
 * Expire stale seat holds from Redis that have passed their hold window.
 * Seat holds use TTL-based expiry automatically, but this worker provides
 * an additional safety net and cleans up user_hold keys that don't have TTL.
 */
export async function expireStaleSeatHolds(): Promise<number> {
  const redis = getRedis();
  let totalReleased = 0;
  let cursor = '0';

  try {
    // Scan for all hold keys using SCAN - use count-based pagination
    do {
      const result = await redis.scan(cursor, 'MATCH', 'movie:hold:*', 'COUNT', '200');
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl <= 0) {
          await redis.del(key);
          totalReleased++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('[MovieWorker] Seat hold expiry scan failed:', err);
  }

  // Clean up user_hold keys (no TTL on these, need manual cleanup)
  cursor = '0';
  try {
    do {
      const result = await redis.scan(cursor, 'MATCH', 'movie:user_hold:*', 'COUNT', '200');
      cursor = result[0];
      const keys = result[1];

      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl <= 0) {
          await redis.del(key);
          totalReleased++;
        }
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('[MovieWorker] User hold expiry scan failed:', err);
  }

  if (totalReleased > 0) {
    logger.info(`[MovieWorker] Released ${totalReleased} stale seat holds`);
  }

  return totalReleased;
}

// ── Entry Point ────────────────────────────────────────────────────────────────

export async function runMovieWorkers(job: MovieWorkerJob = 'all'): Promise<void> {
  logger.info(`[MovieWorker] Starting job: ${job}`);

  try {
    if (job === 'expire' || job === 'all') {
      const expired = await expireStaleMovieBookings();
      if (expired > 0) logger.info(`[MovieWorker] Expired ${expired} stale bookings`);
    }

    if (job === 'expire-holds' || job === 'all') {
      const released = await expireStaleSeatHolds();
      if (released > 0) logger.info(`[MovieWorker] Released ${released} stale seat holds`);
    }

    logger.info(`[MovieWorker] Job ${job} completed`);
  } catch (err) {
    logger.error(`[MovieWorker] Job ${job} failed:`, err);
    throw err;
  }
}

// CLI entry point — only runs when executed directly
if (require.main === module) {
  (async () => {
    const job = (process.argv[2] || 'all') as MovieWorkerJob;
    try {
      await main(job);
    } catch (err) {
      process.exitCode = 1;
    } finally {
      const { closePool } = await import('../db/pool');
      await closePool();
    }
  })();
}

/**
 * Main entry point — callable by the worker scheduler.
 */
export async function main(job: MovieWorkerJob = 'all'): Promise<void> {
  await runMovieWorkers(job);
}
