/**
 * Event Workers — background jobs for event booking cleanup.
 *
 * Exported functions can be called directly (no process.exit).
 * The `runAll()` wrapper handles startup logging.
 *
 * Workers:
 *   - expireStalePendingPayments: Cancel bookings stuck in payment_pending
 *     for longer than the configured timeout (default 30 min).
 *     These bookings hold reserved capacity that should be released.
 */

import { bookingService } from '../services/bookingService';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';

export type EventWorkerJob = 'expire-pending-payments' | 'all';

const STALE_PAYMENT_PENDING_MINUTES = 30;

/**
 * Cancel bookings that have been in payment_pending for longer than
 * the configured timeout, releasing their held capacity.
 */
export async function expireStalePendingPayments(): Promise<number> {
  const client = await getPool().connect();
  let cancelled = 0;

  try {
    await client.query('BEGIN');

    // Find payment_pending bookings whose created_at is older than the threshold
    const staleResult = await client.query(
      `SELECT b.id, b.event_id
       FROM bookings b
       WHERE b.status = 'payment_pending'
         AND b.created_at < NOW() - INTERVAL '${STALE_PAYMENT_PENDING_MINUTES} minutes'
       FOR UPDATE SKIP LOCKED
       LIMIT 100`,
      []
    );

    const staleBookings = staleResult.rows as { id: number; event_id: number }[];

    for (const row of staleBookings) {
      // Cancel the booking via the service (releases capacity, creates tickets as cancelled)
      const result = await bookingService.cancelBooking(
        row.id,
        undefined,
        'Payment timeout — booking auto-cancelled'
      );

      if (result) {
        cancelled++;
        logger.info(`[EventWorker] Auto-cancelled stale payment_pending booking: id=${row.id} event_id=${row.event_id}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[EventWorker] expireStalePendingPayments failed:', err);
    throw err;
  } finally {
    client.release();
  }

  return cancelled;
}

/**
 * Run all event workers.
 */
export async function runEventWorkers(job: EventWorkerJob = 'all'): Promise<void> {
  logger.info(`[EventWorker] Starting job: ${job}`);

  try {
    if (job === 'expire-pending-payments' || job === 'all') {
      const expired = await expireStalePendingPayments();
      if (expired > 0) {
        logger.info(`[EventWorker] Expired ${expired} stale payment_pending bookings`);
      }
    }

    logger.info(`[EventWorker] Job ${job} completed`);
  } catch (err) {
    logger.error(`[EventWorker] Job ${job} failed:`, err);
    throw err;
  }
}

// CLI entry point — only runs when executed directly
if (require.main === module) {
  (async () => {
    const job = (process.argv[2] || 'all') as EventWorkerJob;
    try {
      await runEventWorkers(job);
    } finally {
      const { closePool } = await import('../db/pool');
      await closePool();
    }
  })();
}
