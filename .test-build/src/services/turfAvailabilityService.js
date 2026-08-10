"use strict";
/**
 * Turf Availability Service — slot generation, listing, and Redis locking.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfAvailabilityService = exports.TurfAvailabilityService = void 0;
exports.acquireTurfSlotLock = acquireTurfSlotLock;
exports.releaseTurfSlotLock = releaseTurfSlotLock;
exports.reclaimExpiredLocks = reclaimExpiredLocks;
const pool_1 = require("../db/pool");
const redis_1 = require("../db/redis");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const turfAvailabilityRepository_1 = require("../repositories/turfAvailabilityRepository");
const turfResourceRepository_1 = require("../repositories/turfResourceRepository");
const LOCK_TTL_SECONDS = 120; // 2 minutes
const LEGACY_BOOKING_LOCK_TTL = 10; // Legacy Turf used 10s for booking_slot_lock
// ── Slot Windows ──────────────────────────────────────────────────────────────
function buildSlotWindows(date, startTime, endTime, durationMinutes) {
    const start = new Date(`${date}T${startTime}:00+05:30`);
    const end = new Date(`${date}T${endTime}:00+05:30`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
        throw new errorHandler_1.AppError('Invalid date/time range', 400);
    }
    const windows = [];
    let cursor = start;
    while (cursor < end) {
        const windowEnd = new Date(cursor.getTime() + durationMinutes * 60000);
        if (windowEnd > end)
            break;
        windows.push({ startsAt: cursor, endsAt: windowEnd });
        cursor = windowEnd;
    }
    return windows;
}
// ── Redis Slot Lock Helpers (used by booking service) ─────────────────────────
async function acquireTurfSlotLock(unitId, holderId) {
    const redis = (0, redis_1.getRedis)();
    const lockKey = `turf:slot_lock:${unitId}`;
    const lockToken = `turf:${holderId}:${Date.now()}`;
    const acquired = await redis.set(lockKey, lockToken, 'EX', LEGACY_BOOKING_LOCK_TTL, 'NX');
    if (!acquired) {
        throw new errorHandler_1.AppError('This slot is being booked. Please try again.', 409);
    }
    return lockToken;
}
async function releaseTurfSlotLock(unitId, holderId) {
    try {
        const redis = (0, redis_1.getRedis)();
        const lockKey = `turf:slot_lock:${unitId}`;
        const current = await redis.get(lockKey);
        if (current && current.startsWith(`turf:${holderId}:`)) {
            await redis.del(lockKey);
        }
    }
    catch (err) {
        logger_1.logger.warn(`[TurfRedis] Failed to release lock for unit ${unitId}:`, err);
    }
}
async function reclaimExpiredLocks(resourceId) {
    await (0, pool_1.getPool)().query(`UPDATE turf_availability_units
     SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
     WHERE resource_id = $1 AND status = 'locked' AND lock_expires_at < NOW()`, [resourceId]);
}
// ── Service ───────────────────────────────────────────────────────────────────
class TurfAvailabilityService {
    /**
     * List available slots for a resource on a given date.
     */
    async listSlots(resourceId, date) {
        await turfAvailabilityRepository_1.turfAvailabilityRepository.reclaimExpiredLocks(resourceId);
        const units = await turfAvailabilityRepository_1.turfAvailabilityRepository.findByResource(resourceId, date);
        return units.map(u => turfAvailabilityRepository_1.turfAvailabilityRepository.toPublic(u));
    }
    /**
     * Generate time slots for a slot_based resource.
     */
    async generateSlots(resourceId, date, startTime, endTime, slotDurationMinutes, price) {
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(resourceId);
        if (!resource)
            throw new errorHandler_1.AppError('Resource not found', 404);
        if (resource.resource_type !== 'slot_based') {
            throw new errorHandler_1.AppError('Slot generation only applies to slot_based resources', 400);
        }
        const windows = buildSlotWindows(date, startTime, endTime, slotDurationMinutes);
        if (windows.length === 0) {
            throw new errorHandler_1.AppError('No slots fit in that time range at that duration', 400);
        }
        let createdCount = 0;
        const client = await (0, pool_1.getPool)().connect();
        try {
            await client.query('BEGIN');
            for (const window of windows) {
                const result = await client.query(`INSERT INTO turf_availability_units (resource_id, starts_at, ends_at, price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource_id, starts_at, ends_at) WHERE seat_label IS NULL AND total_capacity IS NULL
           DO NOTHING`, [resourceId, window.startsAt.toISOString(), window.endsAt.toISOString(), price ?? null]);
                if (result.rowCount > 0)
                    createdCount += 1;
            }
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
        return { requested: windows.length, created: createdCount, skippedExisting: windows.length - createdCount };
    }
    /**
     * Lock a slot for a user (first step in booking flow).
     */
    async lockSlot(unitId, holderId) {
        const unit = await turfAvailabilityRepository_1.turfAvailabilityRepository.findById(unitId);
        if (!unit)
            throw new errorHandler_1.AppError('Availability unit not found', 404);
        // Reclaim expired locks on the same resource
        await reclaimExpiredLocks(unit.resource_id);
        const fresh = await turfAvailabilityRepository_1.turfAvailabilityRepository.findById(unitId);
        if (!fresh)
            throw new errorHandler_1.AppError('Availability unit not found', 404);
        if (fresh.status !== 'available') {
            throw new errorHandler_1.AppError('This slot is no longer available', 409);
        }
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE turf_availability_units
       SET status = 'locked', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'available'
       RETURNING *`, [unitId, holderId]);
        if (!rows.length) {
            throw new errorHandler_1.AppError('This slot is no longer available', 409);
        }
        return turfAvailabilityRepository_1.turfAvailabilityRepository.toPublic(rows[0]);
    }
    /**
     * Release a held slot (user cancels booking attempt).
     */
    async releaseSlot(unitId, holderId) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE turf_availability_units
       SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`, [unitId, holderId]);
        if (!rows.length) {
            throw new errorHandler_1.AppError("You don't currently hold a lock on this slot", 400);
        }
        return turfAvailabilityRepository_1.turfAvailabilityRepository.toPublic(rows[0]);
    }
    /**
     * Transition a locked slot to payment_pending after booking creation.
     */
    async markPaymentPending(unitId, holderId) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE turf_availability_units
       SET status = 'payment_pending', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`, [unitId, holderId]);
        if (!rows.length) {
            throw new errorHandler_1.AppError("No lock held on this slot", 400);
        }
        return turfAvailabilityRepository_1.turfAvailabilityRepository.toPublic(rows[0]);
    }
    /**
     * Mark slot as booked (after payment confirmed).
     */
    async markBooked(unitId) {
        await turfAvailabilityRepository_1.turfAvailabilityRepository.markBooked(unitId);
    }
    /**
     * Release slot back to available (after cancellation/expiry).
     */
    async markAvailable(unitId) {
        await turfAvailabilityRepository_1.turfAvailabilityRepository.markAvailable(unitId);
    }
}
exports.TurfAvailabilityService = TurfAvailabilityService;
exports.turfAvailabilityService = new TurfAvailabilityService();
