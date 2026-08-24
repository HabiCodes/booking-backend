/**
 * Turf Availability Scheduler — keeps a rolling 15-day window of availability
 * for all active turf venues.
 *
 * Architecture:
 *  - Internal setInterval (no external cron dependency)
 *  - On startup: bootstrap all venues with the initial 15-day window
 *  - Every 60 minutes: extend rolling window by 1 day, clean up old days
 *  - Concurrency-safe: generation uses ON CONFLICT DO NOTHING via generateSlots
 *  - Cleanup only deletes units with no bookings/holds (safety-first)
 */

import {
  generateForAllVenues as generateForAllVenuesGen,
  extendRollingWindow,
} from './turfAvailabilityGenerator';
import { logger } from '../utils/logger';

const EXTENSION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_BOOTSTRAP_DELAY_MS = 30_000; // 30s after server start

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let bootstrapped = false;

/**
 * Bootstraps all active venues with the initial 15-day availability window.
 * Safe to call multiple times (idempotent via ON CONFLICT DO NOTHING).
 */
export async function bootstrapAvailability(): Promise<void> {
  if (bootstrapped) {
    logger.info('[AvailSched] Already bootstrapped, skipping');
    return;
  }

  logger.info('[AvailSched] Starting availability bootstrap for all active venues...');
  try {
    const summaries = await generateForAllVenuesGen();
    let totalCreated = 0;
    let totalSkipped = 0;
    for (const s of summaries) {
      totalCreated += s.totalCreated;
      totalSkipped += s.totalSkipped;
    }
    logger.info(`[AvailSched] Bootstrap complete: ${summaries.length} venues, ${totalCreated} new slots, ${totalSkipped} existing skipped`);
    bootstrapped = true;
  } catch (err) {
    logger.error('[AvailSched] Bootstrap failed:', err);
    // Don't set bootstrapped = true — retry on next interval
  }
}

/**
 * Extends the rolling window by one day and cleans up old availability.
 */
async function runExtension(): Promise<void> {
  logger.info('[AvailSched] Running rolling window extension...');
  try {
    await extendRollingWindow();
    logger.info('[AvailSched] Extension complete');
  } catch (err) {
    logger.error('[AvailSched] Extension failed:', err);
  }
}

/**
 * Starts the availability scheduler.
 * Call this from server.ts on startup.
 */
export function startAvailabilityScheduler(): void {
  logger.info('[AvailSched] Starting availability scheduler...');

  // Bootstrap after a short delay (let the server finish starting up)
  setTimeout(() => {
    bootstrapAvailability().catch((err) => {
      logger.error('[AvailSched] Bootstrap threw:', err);
    });
  }, INITIAL_BOOTSTRAP_DELAY_MS);

  // Then extend the rolling window every hour
  schedulerInterval = setInterval(() => {
    runExtension();
  }, EXTENSION_INTERVAL_MS);

  logger.info(`[AvailSched] Scheduler running (interval: ${EXTENSION_INTERVAL_MS / 1000}s)`);
}

/**
 * Stops the availability scheduler.
 * Useful for testing and graceful shutdown.
 */
export function stopAvailabilityScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[AvailSched] Scheduler stopped');
  }
}

// ── Distributed-lock-aware scheduler start ───────────────────────────────────
// When multiple API instances run, only one should execute bootstrap/extension.

import { tryAcquireSchedulerLock, releaseSchedulerLock } from '../infrastructure/schedulerLock';

const SCHEDULER_LOCK_ID = 'availability-scheduler';
const SCHEDULER_LOCK_TTL_SECONDS = 3700; // Slightly longer than 1-hour interval

export function startAvailabilitySchedulerWithLock(): void {
  logger.info('[AvailSched] Starting availability scheduler (distributed lock)...');

  async function tryBootstrap(): Promise<void> {
    const locked = await tryAcquireSchedulerLock(SCHEDULER_LOCK_ID, SCHEDULER_LOCK_TTL_SECONDS);
    if (!locked) {
      logger.info('[AvailSched] Another instance holds the scheduler lock — skipping bootstrap');
      return;
    }

    try {
      await bootstrapAvailability();
    } catch (err) {
      logger.error('[AvailSched] Bootstrap threw:', err);
    } finally {
      // Keep the lock held so interval runs are also coordinated
    }
  }

  async function tryExtension(): Promise<void> {
    const locked = await tryAcquireSchedulerLock(SCHEDULER_LOCK_ID, SCHEDULER_LOCK_TTL_SECONDS);
    if (!locked) {
      logger.debug('[AvailSched] Another instance holds the scheduler lock — skipping extension');
      return;
    }

    try {
      await runExtension();
    } catch (err) {
      logger.error('[AvailSched] Extension threw:', err);
    }
  }

  // Bootstrap after a short delay
  setTimeout(() => {
    tryBootstrap();
  }, INITIAL_BOOTSTRAP_DELAY_MS);

  // Extend the rolling window every hour
  schedulerInterval = setInterval(() => {
    tryExtension();
  }, EXTENSION_INTERVAL_MS);

  logger.info(`[AvailSched] Scheduler running (interval: ${EXTENSION_INTERVAL_MS / 1000}s, distributed lock)`);
}
