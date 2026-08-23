/**
 * Turf Workers — background jobs for slot expiration and booking completion.
 *
 * Exported functions can be called directly (no process.exit).
 * The `runAll()` wrapper handles startup logging.
 */

import { turfBookingService } from '../services/turfBookingService';
import { availabilityEngine } from '../services/turfAvailabilityEngine';
import { logger } from '../utils/logger';

export type TurfWorkerJob = 'expire' | 'complete' | 'all';

// ── Workers ────────────────────────────────────────────────────────────────────

export async function turfExpireStaleBookings(): Promise<number> {
  return turfBookingService.expireStaleBookings();
}

export async function turfCompleteEndedSlots(): Promise<number> {
  return turfBookingService.completeEndedSlots();
}

export async function turfExpireStaleHolds(): Promise<number> {
  return availabilityEngine.expireStaleHolds();
}

export async function turfReconcileStaleLocks(): Promise<number> {
  return availabilityEngine.reconcileStaleLocks();
}

// ── Entry Point ────────────────────────────────────────────────────────────────

export async function runTurfWorkers(job: TurfWorkerJob = 'all'): Promise<void> {
  logger.info(`[TurfWorker] Starting job: ${job}`);

  try {
    if (job === 'expire' || job === 'all') {
      const [expired, holds, locks] = await Promise.all([
        turfExpireStaleBookings(),
        turfExpireStaleHolds(),
        turfReconcileStaleLocks(),
      ]);
      if (expired > 0) logger.info(`[TurfWorker] Expired ${expired} stale bookings`);
      if (holds > 0) logger.info(`[TurfWorker] Expired ${holds} stale holds`);
      if (locks > 0) logger.info(`[TurfWorker] Reconciled ${locks} stale locks`);
    }

    if (job === 'complete' || job === 'all') {
      const completed = await turfCompleteEndedSlots();
      if (completed > 0) logger.info(`[TurfWorker] Completed ${completed} ended slots`);
    }

    logger.info(`[TurfWorker] Job ${job} completed`);
  } catch (err) {
    logger.error(`[TurfWorker] Job ${job} failed:`, err);
    throw err;
  }
}

// CLI entry point — only runs when executed directly
if (require.main === module) {
  (async () => {
    const job = (process.argv[2] || 'all') as TurfWorkerJob;
    try {
      await runTurfWorkers(job);
    } finally {
      const { closePool } = await import('../db/pool');
      await closePool();
    }
  })();
}
