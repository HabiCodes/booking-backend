/**
 * Turf Workers — background jobs for slot expiration and booking completion.
 *
 * Run via: node dist/workers/turfWorkers.js
 * Or schedule via cron (every 5 min): node dist/workers/turfWorkers.js expire
 */

import { turfBookingService } from '../services/turfBookingService';
import { availabilityEngine } from '../services/turfAvailabilityEngine';
import { logger } from '../utils/logger';
import { getPool, closePool } from '../db/pool';

type WorkerJob = 'expire' | 'complete' | 'all';

// ── Workers ──────────────────────────────────────────────────────────────────

async function expireStaleBookings() {
  try {
    const count = await turfBookingService.expireStaleBookings();
    logger.info(`[TurfWorker] expireStaleBookings done: ${count} expired`);
  } catch (err) {
    logger.error('[TurfWorker] expireStaleBookings failed:', err);
  }
}

async function completeEndedSlots() {
  try {
    const count = await turfBookingService.completeEndedSlots();
    logger.info(`[TurfWorker] completeEndedSlots done: ${count} completed`);
  } catch (err) {
    logger.error('[TurfWorker] completeEndedSlots failed:', err);
  }
}

async function expireStaleHolds() {
  try {
    const count = await availabilityEngine.expireStaleHolds();
    logger.info(`[TurfWorker] expireStaleHolds done: ${count} expired`);
  } catch (err) {
    logger.error('[TurfWorker] expireStaleHolds failed:', err);
  }
}

async function reconcileStaleLocks() {
  try {
    const count = await availabilityEngine.reconcileStaleLocks();
    logger.info(`[TurfWorker] reconcileStaleLocks done: ${count} reconciled`);
  } catch (err) {
    logger.error('[TurfWorker] reconcileStaleLocks failed:', err);
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const job = (process.argv[2] || 'all') as WorkerJob;
  logger.info(`[TurfWorker] Starting job: ${job}`);

  try {
    if (job === 'expire' || job === 'all') {
      await expireStaleBookings();
      await expireStaleHolds();
      await reconcileStaleLocks();
    }

    if (job === 'complete' || job === 'all') {
      await completeEndedSlots();
    }

    logger.info(`[TurfWorker] Job ${job} completed`);
  } catch (err) {
    logger.error(`[TurfWorker] Job ${job} failed:`, err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
