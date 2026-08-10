/**
 * Turf Availability Service — slot generation, listing, and Redis locking.
 */

import { getPool } from '../db/pool';
import { getRedis } from '../db/redis';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { turfAvailabilityRepository } from '../repositories/turfAvailabilityRepository';
import { turfResourceRepository } from '../repositories/turfResourceRepository';

const LOCK_TTL_SECONDS = 120; // 2 minutes
const LEGACY_BOOKING_LOCK_TTL = 10; // Legacy Turf used 10s for booking_slot_lock

// ── Slot Windows ──────────────────────────────────────────────────────────────

function buildSlotWindows(date: string, startTime: string, endTime: string, durationMinutes: number): Array<{ startsAt: Date; endsAt: Date }> {
  const start = new Date(`${date}T${startTime}:00+05:30`);
  const end = new Date(`${date}T${endTime}:00+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new AppError('Invalid date/time range', 400);
  }

  const windows: Array<{ startsAt: Date; endsAt: Date }> = [];
  let cursor = start;
  while (cursor < end) {
    const windowEnd = new Date(cursor.getTime() + durationMinutes * 60_000);
    if (windowEnd > end) break;
    windows.push({ startsAt: cursor, endsAt: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}

// ── Redis Slot Lock Helpers (used by booking service) ─────────────────────────

export async function acquireTurfSlotLock(unitId: number, holderId: number): Promise<string> {
  const redis = getRedis();
  const lockKey = `turf:slot_lock:${unitId}`;
  const lockToken = `turf:${holderId}:${Date.now()}`;

  const acquired = await redis.set(lockKey, lockToken, 'EX', LEGACY_BOOKING_LOCK_TTL, 'NX');
  if (!acquired) {
    throw new AppError('This slot is being booked. Please try again.', 409);
  }

  return lockToken;
}

export async function releaseTurfSlotLock(unitId: number, holderId: number): Promise<void> {
  try {
    const redis = getRedis();
    const lockKey = `turf:slot_lock:${unitId}`;
    const current = await redis.get(lockKey);
    if (current && current.startsWith(`turf:${holderId}:`)) {
      await redis.del(lockKey);
    }
  } catch (err) {
    logger.warn(`[TurfRedis] Failed to release lock for unit ${unitId}:`, err);
  }
}

export async function reclaimExpiredLocks(resourceId: number): Promise<void> {
  await getPool().query(
    `UPDATE turf_availability_units
     SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
     WHERE resource_id = $1 AND status = 'locked' AND lock_expires_at < NOW()`,
    [resourceId]
  );
}

// ── Service ───────────────────────────────────────────────────────────────────

export class TurfAvailabilityService {

  /**
   * List available slots for a resource on a given date.
   */
  async listSlots(resourceId: number, date: string) {
    await turfAvailabilityRepository.reclaimExpiredLocks(resourceId);
    const units = await turfAvailabilityRepository.findByResource(resourceId, date);
    return units.map(u => turfAvailabilityRepository.toPublic(u));
  }

  /**
   * Generate time slots for a slot_based resource.
   */
  async generateSlots(resourceId: number, date: string, startTime: string, endTime: string, slotDurationMinutes: number, price?: number) {
    const resource = await turfResourceRepository.findById(resourceId);
    if (!resource) throw new AppError('Resource not found', 404);
    if (resource.resource_type !== 'slot_based') {
      throw new AppError('Slot generation only applies to slot_based resources', 400);
    }

    const windows = buildSlotWindows(date, startTime, endTime, slotDurationMinutes);
    if (windows.length === 0) {
      throw new AppError('No slots fit in that time range at that duration', 400);
    }

    let createdCount = 0;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const window of windows) {
        const result = await client.query(
          `INSERT INTO turf_availability_units (resource_id, starts_at, ends_at, price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource_id, starts_at, ends_at) WHERE seat_label IS NULL AND total_capacity IS NULL
           DO NOTHING`,
          [resourceId, window.startsAt.toISOString(), window.endsAt.toISOString(), price ?? null]
        );
        if ((result as any).rowCount > 0) createdCount += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { requested: windows.length, created: createdCount, skippedExisting: windows.length - createdCount };
  }

  /**
   * Lock a slot for a user (first step in booking flow).
   */
  async lockSlot(unitId: number, holderId: number) {
    const unit = await turfAvailabilityRepository.findById(unitId);
    if (!unit) throw new AppError('Availability unit not found', 404);

    // Reclaim expired locks on the same resource
    await reclaimExpiredLocks(unit.resource_id);

    const fresh = await turfAvailabilityRepository.findById(unitId);
    if (!fresh) throw new AppError('Availability unit not found', 404);
    if (fresh.status !== 'available') {
      throw new AppError('This slot is no longer available', 409);
    }

    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'locked', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'available'
       RETURNING *`,
      [unitId, holderId]
    );
    if (!rows.length) {
      throw new AppError('This slot is no longer available', 409);
    }
    return turfAvailabilityRepository.toPublic(rows[0]);
  }

  /**
   * Release a held slot (user cancels booking attempt).
   */
  async releaseSlot(unitId: number, holderId: number) {
    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`,
      [unitId, holderId]
    );
    if (!rows.length) {
      throw new AppError("You don't currently hold a lock on this slot", 400);
    }
    return turfAvailabilityRepository.toPublic(rows[0]);
  }

  /**
   * Transition a locked slot to payment_pending after booking creation.
   */
  async markPaymentPending(unitId: number, holderId: number) {
    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'payment_pending', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`,
      [unitId, holderId]
    );
    if (!rows.length) {
      throw new AppError("No lock held on this slot", 400);
    }
    return turfAvailabilityRepository.toPublic(rows[0]);
  }

  /**
   * Mark slot as booked (after payment confirmed).
   */
  async markBooked(unitId: number): Promise<void> {
    await turfAvailabilityRepository.markBooked(unitId);
  }

  /**
   * Release slot back to available (after cancellation/expiry).
   */
  async markAvailable(unitId: number): Promise<void> {
    await turfAvailabilityRepository.markAvailable(unitId);
  }
}

export const turfAvailabilityService = new TurfAvailabilityService();
