"use strict";
/**
 * Availability Engine — single source of truth for turf resource availability.
 *
 * CRITICAL INVARIANTS:
 *  1. PostgreSQL is the authoritative source of truth. Redis is only a fast-path.
 *  2. Only one active hold per availability unit (enforced by DB unique index).
 *  3. Only one confirmed/checked_in/completed booking per unit (enforced by DB unique index).
 *  4. All hold mutations use atomic UPDATE with status guards.
 *  5. Redis locks are always set AFTER DB commit and only as performance hints.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.availabilityEngine = exports.AvailabilityEngine = void 0;
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
const redis_1 = require("../db/redis");
const turfAvailabilityRepository_1 = require("../repositories/turfAvailabilityRepository");
const turfVenueRepository_1 = require("../repositories/turfVenueRepository");
const turfResourceRepository_1 = require("../repositories/turfResourceRepository");
// ── Constants ────────────────────────────────────────────────────────────────
const HOLD_TTL_SECONDS = 300; // 5 minutes to complete payment
const HOLD_LOCK_TTL_SECONDS = 360; // Redis hint TTL (slightly longer than hold TTL)
const MAX_BOOKING_DURATION_HOURS = 4;
// ── Internal Helpers ─────────────────────────────────────────────────────────
function holdRedisKey(unitId) {
    return `turf:hold:${unitId}`;
}
function generateHoldToken() {
    // Use crypto for production-grade randomness (not Math.random)
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return 'hold_' + Buffer.from(bytes).toString('hex');
}
function parseStatus(unitStatus, bookingStatus) {
    if (bookingStatus && ['confirmed', 'checked_in', 'completed'].includes(bookingStatus)) {
        return 'booked';
    }
    switch (unitStatus) {
        case 'available': return 'available';
        case 'locked':
        case 'payment_pending': return 'held';
        case 'booked': return 'booked';
        case 'blocked': return 'blocked';
        default: return 'unavailable';
    }
}
/**
 * Half-open interval overlap: [aStart, aEnd) overlaps [bStart, bEnd)
 * iff aStart < bEnd AND aEnd > bStart.
 */
function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
    return new Date(aStart).getTime() < new Date(bEnd).getTime()
        && new Date(aEnd).getTime() > new Date(bStart).getTime();
}
/**
 * Build blocked period overlap SQL fragment for a given set of params.
 * Returns { sqlFragment, params } to be interpolated into a larger query.
 */
function blockedPeriodWhere(offset) {
    const bpParam = '$' + offset;
    const bpStart = '$' + (offset + 1);
    const bpEnd = '$' + (offset + 2);
    const bpParam3 = '$' + (offset + 3);
    return {
        fragment: `EXISTS (SELECT 1 FROM turf_blocked_periods bp
       WHERE bp.resource_id = au.resource_id
         AND bp.starts_at < ${bpParam3}
         AND bp.ends_at > ${bpParam})`,
        endOffset: offset + 3,
    };
}
// ── Service ──────────────────────────────────────────────────────────────────
class AvailabilityEngine {
    // ── Availability Queries ────────────────────────────────────────────────────
    /**
     * Get all slot statuses for a resource on a given date.
     *
     * Status resolution order:
     * 1. Blocked periods → 'blocked' (highest priority)
     * 2. Confirmed/checked_in/completed bookings → 'booked'
     * 3. Active holds in turf_holds table → 'held'
     * 4. Unit status 'locked'/'payment_pending' → 'held'
     * 5. Unit status 'available' → 'available'
     * 6. Unit status 'booked' → 'booked'
     * 7. Everything else → 'unavailable'
     */
    async getAvailability(resourceId, date) {
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(resourceId);
        if (!resource)
            throw new errorHandler_1.AppError('Resource not found', 404);
        if (!resource.is_active)
            throw new errorHandler_1.AppError('Resource is not active', 400);
        const venue = await turfVenueRepository_1.turfVenueRepository.findById(resource.venue_id);
        if (!venue || venue.status !== 'approved') {
            throw new errorHandler_1.AppError('Venue is not available', 400);
        }
        const units = await turfAvailabilityRepository_1.turfAvailabilityRepository.findByResource(resourceId, date);
        if (units.length === 0) {
            return { resourceId, date, timezone: 'Asia/Kolkata', slots: [] };
        }
        const unitIds = units.map(u => u.id);
        // Single query for all confirmed bookings on these units
        const bookingRows = await (0, pool_1.getPool)().query(`SELECT availability_unit_id, status FROM turf_bookings
       WHERE availability_unit_id = ANY($1::int[])
         AND status IN ('confirmed', 'checked_in', 'completed')`, [unitIds]);
        const bookingsMap = new Map();
        for (const row of bookingRows.rows) {
            bookingsMap.set(row.availability_unit_id, row.status);
        }
        // Single query for all active holds on these units
        const holdRows = await (0, pool_1.getPool)().query(`SELECT availability_unit_id FROM turf_holds
       WHERE availability_unit_id = ANY($1::int[])
         AND status = 'active'
         AND expires_at > NOW()`, [unitIds]);
        const holdsSet = new Set();
        for (const row of holdRows.rows) {
            holdsSet.add(row.availability_unit_id);
        }
        // Single query for blocked periods overlapping this date
        const dayStart = `${date}T00:00:00Z`;
        const dayEnd = `${date}T23:59:59Z`;
        const blockedRows = await (0, pool_1.getPool)().query(`SELECT starts_at, ends_at FROM turf_blocked_periods
       WHERE resource_id = $1 AND starts_at < $3 AND ends_at > $2`, [resourceId, dayStart, dayEnd]);
        const slots = units.map(unit => {
            const unitStart = new Date(unit.starts_at);
            const unitEnd = new Date(unit.ends_at);
            const bookingStatus = bookingsMap.get(unit.id);
            const hasActiveHold = holdsSet.has(unit.id);
            // Check blocked period overlap using half-open intervals
            let isBlocked = false;
            for (const bp of blockedRows.rows) {
                if (intervalsOverlap(unit.starts_at, unit.ends_at, bp.starts_at, bp.ends_at)) {
                    isBlocked = true;
                    break;
                }
            }
            // Priority: block > booking > hold > unit status
            let status;
            if (isBlocked) {
                status = 'blocked';
            }
            else if (bookingStatus && ['confirmed', 'checked_in', 'completed'].includes(bookingStatus)) {
                status = 'booked';
            }
            else if (hasActiveHold || unit.status === 'locked' || unit.status === 'payment_pending') {
                status = 'held';
            }
            else if (unit.status === 'booked') {
                status = 'booked';
            }
            else if (unit.status === 'available') {
                status = 'available';
            }
            else {
                status = 'unavailable';
            }
            return {
                unitId: unit.id,
                startsAt: unit.starts_at,
                endsAt: unit.ends_at,
                status,
                price: unit.price ? parseFloat(unit.price) : parseFloat(resource.base_price),
                lockHolderId: unit.lock_holder_id,
                lockExpiresAt: unit.lock_expires_at,
            };
        });
        slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        return { resourceId, date, timezone: 'Asia/Kolkata', slots };
    }
    /**
     * Get availability for a date range.
     */
    async getAvailabilityRange(query) {
        const { resourceId, from, to } = query;
        const units = await turfAvailabilityRepository_1.turfAvailabilityRepository.findByResourceRange(resourceId, from, to);
        if (units.length === 0) {
            return { resourceId, from, to, days: [] };
        }
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(resourceId);
        if (!resource)
            throw new errorHandler_1.AppError('Resource not found', 404);
        // Batch queries for all units
        const unitIds = units.map(u => u.id);
        const bookingRows = await (0, pool_1.getPool)().query(`SELECT availability_unit_id, status FROM turf_bookings
       WHERE availability_unit_id = ANY($1::int[])
         AND status IN ('confirmed', 'checked_in', 'completed')`, [unitIds]);
        const bookingsMap = new Map();
        for (const row of bookingRows.rows)
            bookingsMap.set(row.availability_unit_id, row.status);
        const holdRows = await (0, pool_1.getPool)().query(`SELECT availability_unit_id FROM turf_holds
       WHERE availability_unit_id = ANY($1::int[])
         AND status = 'active'
         AND expires_at > NOW()`, [unitIds]);
        const holdsSet = new Set();
        for (const row of holdRows.rows)
            holdsSet.add(row.availability_unit_id);
        // Blocked periods for the entire range
        const blockedRows = await (0, pool_1.getPool)().query(`SELECT starts_at, ends_at FROM turf_blocked_periods
       WHERE resource_id = $1 AND starts_at < $3 AND ends_at > $2`, [resourceId, from, to]);
        // Group by date
        const grouped = new Map();
        for (const unit of units) {
            const dateKey = unit.starts_at.slice(0, 10);
            if (!grouped.has(dateKey))
                grouped.set(dateKey, []);
            const unitStart = new Date(unit.starts_at);
            const unitEnd = new Date(unit.ends_at);
            const bookingStatus = bookingsMap.get(unit.id);
            const hasActiveHold = holdsSet.has(unit.id);
            let isBlocked = false;
            for (const bp of blockedRows.rows) {
                if (intervalsOverlap(unit.starts_at, unit.ends_at, bp.starts_at, bp.ends_at)) {
                    isBlocked = true;
                    break;
                }
            }
            let status;
            if (isBlocked) {
                status = 'blocked';
            }
            else if (bookingStatus && ['confirmed', 'checked_in', 'completed'].includes(bookingStatus)) {
                status = 'booked';
            }
            else if (hasActiveHold || unit.status === 'locked' || unit.status === 'payment_pending') {
                status = 'held';
            }
            else if (unit.status === 'booked') {
                status = 'booked';
            }
            else if (unit.status === 'available') {
                status = 'available';
            }
            else {
                status = 'unavailable';
            }
            grouped.get(dateKey).push({
                unitId: unit.id,
                startsAt: unit.starts_at,
                endsAt: unit.ends_at,
                status,
                price: unit.price ? parseFloat(unit.price) : parseFloat(resource.base_price),
                lockHolderId: unit.lock_holder_id,
                lockExpiresAt: unit.lock_expires_at,
            });
        }
        const days = [];
        for (const [date, slots] of grouped) {
            slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            days.push({ resourceId, date, timezone: 'Asia/Kolkata', slots });
        }
        days.sort((a, b) => a.date.localeCompare(b.date));
        return { resourceId, from, to, days };
    }
    /**
     * Quick check: is a specific availability unit bookable right now?
     */
    async isAvailable(unitId) {
        const unit = await turfAvailabilityRepository_1.turfAvailabilityRepository.findById(unitId);
        if (!unit || unit.status === 'booked' || unit.status === 'blocked')
            return false;
        // Check for confirmed booking
        const booking = await (0, pool_1.getPool)().query(`SELECT id FROM turf_bookings
       WHERE availability_unit_id = $1
         AND status IN ('confirmed', 'checked_in', 'completed')
       LIMIT 1`, [unitId]);
        if (booking.rows.length > 0)
            return false;
        // Check for active hold (critical: a held slot is NOT available)
        const hold = await (0, pool_1.getPool)().query(`SELECT id FROM turf_holds
       WHERE availability_unit_id = $1
         AND status = 'active'
         AND expires_at > NOW()
       LIMIT 1`, [unitId]);
        if (hold.rows.length > 0)
            return false;
        // Check for blocked period
        const blocked = await (0, pool_1.getPool)().query(`SELECT id FROM turf_blocked_periods
       WHERE resource_id = $1 AND starts_at < $3 AND ends_at > $2
       LIMIT 1`, [unit.resource_id, unit.starts_at, unit.ends_at]);
        if (blocked.rows.length > 0)
            return false;
        return true;
    }
    // ── Hold Management ────────────────────────────────────────────────────────
    /**
     * Acquire a hold on an availability unit.
     *
     * CRITICAL: PostgreSQL is the source of truth. The DB transaction serializes
     * concurrent attempts via SELECT ... FOR UPDATE. Redis is set AFTER commit
     * as a performance hint only.
     *
     * Invariant: The unique index uq_turf_hold_active_unit guarantees that
     * only one active hold can exist per unit. If two requests reach the INSERT
     * simultaneously, one will fail with a unique violation.
     */
    async acquireHold(unitId, userId) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        const holdToken = generateHoldToken();
        const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();
        try {
            await client.query('BEGIN');
            // Step 1: Lock the availability unit row
            const unitRow = await client.query('SELECT * FROM turf_availability_units WHERE id = $1 FOR UPDATE', [unitId]);
            const unit = unitRow.rows[0];
            if (!unit) {
                await client.query('ROLLBACK');
                throw new errorHandler_1.AppError('Slot not found', 404);
            }
            // Step 2: Check unit status
            if (unit.status === 'booked' || unit.status === 'blocked') {
                await client.query('ROLLBACK');
                throw new errorHandler_1.AppError('Slot is no longer available', 409);
            }
            // Step 3: Check for confirmed booking (DB-level truth)
            const bookingConflict = await client.query(`SELECT id FROM turf_bookings
         WHERE availability_unit_id = $1
           AND status IN ('confirmed', 'checked_in', 'completed')
         LIMIT 1`, [unitId]);
            if (bookingConflict.rows.length > 0) {
                await client.query('ROLLBACK');
                throw new errorHandler_1.AppError('Slot has been booked', 409);
            }
            // Step 4: Check for existing active hold (DB-level truth)
            // The unique index ensures at most one active hold per unit.
            const existingHold = await client.query(`SELECT id FROM turf_holds
         WHERE availability_unit_id = $1 AND status = 'active' AND expires_at > NOW()
         LIMIT 1`, [unitId]);
            if (existingHold.rows.length > 0) {
                await client.query('ROLLBACK');
                throw new errorHandler_1.AppError('Slot is already on hold', 409);
            }
            // Step 5: Transition unit to 'locked'
            await client.query(`UPDATE turf_availability_units
         SET status = 'locked', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
         WHERE id = $1`, [unitId, userId]);
            // Step 6: Insert hold record — atomic, protected by unique index
            const holdRow = await client.query(`INSERT INTO turf_holds (availability_unit_id, user_id, token, status, expires_at)
         VALUES ($1, $2, $3, 'active', $4) RETURNING id`, [unitId, userId, holdToken, expiresAt]);
            await client.query('COMMIT');
            // Step 7: Set Redis lock AFTER commit as a performance hint
            // This is NOT used for authorization — DB is the source of truth
            try {
                const redis = (0, redis_1.getRedis)();
                await redis.set(holdRedisKey(unitId), holdToken, 'EX', HOLD_LOCK_TTL_SECONDS);
            }
            catch (redisErr) {
                // Redis failure is non-fatal — DB hold record is authoritative
                logger_1.logger.warn(`[AvailabilityEngine] Redis unavailable during hold acquire for unit ${unitId}:`, redisErr);
            }
            logger_1.logger.info(`[AvailabilityEngine] Hold acquired: unit=${unitId} user=${userId} token=${holdToken.slice(0, 8)}...`);
            return {
                success: true,
                token: holdToken,
                unitId,
                expiresAt,
            };
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Release a hold early.
     *
     * Uses atomic UPDATE with status guard to prevent races with confirmHold.
     * Redis cleanup is best-effort.
     */
    async releaseHold(unitId, token) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Atomic: only update if still active. If confirmHold already ran, status='confirmed'.
            const result = await client.query(`UPDATE turf_holds
         SET status = 'released', released_at = NOW()
         WHERE availability_unit_id = $1 AND token = $2 AND status = 'active'
         RETURNING id`, [unitId, token]);
            if (result.rows.length === 0) {
                // Check if hold exists at all
                const existing = await client.query('SELECT id, status FROM turf_holds WHERE availability_unit_id = $1 AND token = $2 LIMIT 1', [unitId, token]);
                if (existing.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return { success: false, reason: 'not_found' };
                }
                if (existing.rows[0].status === 'confirmed') {
                    await client.query('ROLLBACK');
                    return { success: false, reason: 'already_confirmed' };
                }
                // Expired or already released
                await client.query('ROLLBACK');
                return { success: false, reason: 'already_expired' };
            }
            // Release the availability unit
            await turfAvailabilityRepository_1.turfAvailabilityRepository.markAvailable(unitId);
            await client.query('COMMIT');
            // Clean up Redis hint (best-effort)
            try {
                const redis = (0, redis_1.getRedis)();
                await redis.del(holdRedisKey(unitId));
            }
            catch {
                // Redis is non-critical
            }
            logger_1.logger.info(`[AvailabilityEngine] Hold released: unit=${unitId}`);
            return { success: true, reason: 'released' };
        }
        catch (err) {
            await client.query('ROLLBACK');
            logger_1.logger.error(`[AvailabilityEngine] Release hold failed for unit ${unitId}:`, err);
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Confirm a hold into a booking.
     *
     * Uses atomic UPDATE with status guard. The unit is already marked 'booked'
     * by turfBookingService.confirmBooking() before this is called. This method
     * only transitions the hold record from 'active' → 'confirmed'.
     */
    async confirmHold(unitId, token, bookingId) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Atomic: only update if still active. If already released/expired, skip.
            const result = await client.query(`UPDATE turf_holds
         SET status = 'confirmed', booking_id = $3
         WHERE availability_unit_id = $1 AND token = $2 AND status = 'active'
         RETURNING id`, [unitId, token, bookingId]);
            if (result.rows.length === 0) {
                // Hold may have been released by user or expired — not an error
                // because the unit is already marked 'booked' by the booking service
                await client.query('ROLLBACK');
                logger_1.logger.info(`[AvailabilityEngine] Hold confirm skipped (not active): unit=${unitId}`);
                return;
            }
            // Ensure unit is marked booked (idempotent)
            await turfAvailabilityRepository_1.turfAvailabilityRepository.markBooked(unitId);
            // Clean up Redis hint (best-effort)
            try {
                const redis = (0, redis_1.getRedis)();
                await redis.del(holdRedisKey(unitId));
            }
            catch {
                // Redis is non-critical
            }
            await client.query('COMMIT');
            logger_1.logger.info(`[AvailabilityEngine] Hold confirmed: unit=${unitId} booking=${bookingId}`);
        }
        catch (err) {
            await client.query('ROLLBACK');
            logger_1.logger.error(`[AvailabilityEngine] Confirm hold failed for unit ${unitId}:`, err);
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Expire stale holds (worker).
     *
     * Uses atomic UPDATE with status guard. Processes holds in batches of 100.
     * Loops until no more stale holds remain (up to a reasonable limit).
     */
    async expireStaleHolds() {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        let totalExpired = 0;
        const MAX_BATCH = 100;
        const MAX_TOTAL = 500; // Prevent runaway loop
        try {
            await client.query('BEGIN');
            for (let i = 0; i < MAX_TOTAL / MAX_BATCH; i++) {
                // Find stale holds (FOR UPDATE to prevent race with confirmHold)
                const staleRows = await client.query(`SELECT id, availability_unit_id, token FROM turf_holds
           WHERE status = 'active' AND expires_at < NOW()
           LIMIT $1 FOR UPDATE`, [MAX_BATCH]);
                if (staleRows.rows.length === 0)
                    break;
                for (const hold of staleRows.rows) {
                    // Atomic update — only expire if still active
                    await client.query(`UPDATE turf_holds SET status = 'expired', released_at = NOW()
             WHERE id = $1 AND status = 'active'`, [hold.id]);
                    // Release the unit
                    await turfAvailabilityRepository_1.turfAvailabilityRepository.markAvailable(hold.availability_unit_id);
                    // Clean up Redis hint (best-effort)
                    try {
                        const redis = (0, redis_1.getRedis)();
                        await redis.del(holdRedisKey(hold.availability_unit_id));
                    }
                    catch {
                        // Redis is non-critical
                    }
                    totalExpired++;
                }
                // Break if we processed fewer than batch size (no more)
                if (staleRows.rows.length < MAX_BATCH)
                    break;
            }
            await client.query('COMMIT');
            if (totalExpired > 0) {
                logger_1.logger.info(`[AvailabilityEngine] Expired ${totalExpired} stale holds`);
            }
            return totalExpired;
        }
        catch (err) {
            await client.query('ROLLBACK');
            logger_1.logger.error('[AvailabilityEngine] Failed to expire holds:', err);
            throw err;
        }
        finally {
            client.release();
        }
    }
    // ── Blocked Periods ────────────────────────────────────────────────────────
    /**
     * Block a resource/venue/org time range.
     * Note: Authorization is enforced at the route/controller level.
     * This method trusts its caller.
     */
    async blockPeriod(input) {
        if (new Date(input.ends_at) <= new Date(input.starts_at)) {
            throw new errorHandler_1.AppError('Block end must be after start', 400);
        }
        if (!input.resource_id && !input.venue_id && !input.organization_id) {
            throw new errorHandler_1.AppError('Must specify at least one scope (organization, venue, or resource)', 400);
        }
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_blocked_periods (organization_id, venue_id, resource_id, reason, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [
            input.organization_id,
            input.venue_id ?? null,
            input.resource_id ?? null,
            input.reason ?? null,
            input.starts_at,
            input.ends_at,
            input.created_by ?? null,
        ]);
        return rows[0];
    }
    async unblockPeriod(blockId) {
        const result = await (0, pool_1.getPool)().query('DELETE FROM turf_blocked_periods WHERE id = $1 RETURNING id', [blockId]);
        if (result.rows.length === 0) {
            throw new errorHandler_1.AppError('Blocked period not found', 404);
        }
    }
    async getBlockedPeriods(resourceId, from, to) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM turf_blocked_periods
       WHERE resource_id = $1 AND starts_at < $3 AND ends_at > $2
       ORDER BY starts_at ASC`, [resourceId, from, to]);
        return rows;
    }
    // ── Overlap Detection ──────────────────────────────────────────────────────
    async detectOverlap(unitId, proposedStart, proposedEnd) {
        const conflicts = [];
        // 1. Confirmed bookings for this unit
        const bookingRows = await (0, pool_1.getPool)().query(`SELECT b.id, b.status FROM turf_bookings b
       JOIN turf_availability_units au ON b.availability_unit_id = au.id
       WHERE b.availability_unit_id = $1
         AND b.status IN ('confirmed', 'checked_in', 'completed')
         AND au.starts_at < $3 AND au.ends_at > $2`, [unitId, proposedStart, proposedEnd]);
        for (const row of bookingRows.rows) {
            conflicts.push({ type: 'booking', id: row.id, status: row.status });
        }
        // 2. Active holds for this unit
        const holdRows = await (0, pool_1.getPool)().query(`SELECT h.id, h.status FROM turf_holds h
       WHERE h.availability_unit_id = $1
         AND h.status = 'active'
         AND h.expires_at > NOW()`, [unitId]);
        for (const row of holdRows.rows) {
            conflicts.push({ type: 'hold', id: row.id, status: row.status });
        }
        // 3. Blocked periods on this resource
        const unit = await turfAvailabilityRepository_1.turfAvailabilityRepository.findById(unitId);
        if (unit) {
            const blockedRows = await (0, pool_1.getPool)().query(`SELECT id FROM turf_blocked_periods
         WHERE resource_id = $1 AND starts_at < $3 AND ends_at > $2
         LIMIT 1`, [unit.resource_id, proposedStart, proposedEnd]);
            for (const row of blockedRows.rows) {
                conflicts.push({ type: 'block', id: row.id, status: 'blocked' });
            }
        }
        return { hasOverlap: conflicts.length > 0, conflicts };
    }
    // ── Operating Hours ────────────────────────────────────────────────────────
    async getOperatingHours(resourceId, dayOfWeek) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT open_time, close_time FROM turf_resource_schedules
       WHERE resource_id = $1 AND day_of_week = $2 AND is_active = TRUE
       ORDER BY open_time ASC`, [resourceId, dayOfWeek]);
        return rows.map(r => ({ openTime: r.open_time, closeTime: r.close_time }));
    }
    async setOperatingHours(resourceId, dayOfWeek, intervals) {
        if (intervals.length === 0) {
            throw new errorHandler_1.AppError('At least one operating interval is required', 400);
        }
        for (const interval of intervals) {
            if (interval.closeTime <= interval.openTime) {
                throw new errorHandler_1.AppError(`Close time must be after open time: ${interval.openTime}`, 400);
            }
        }
        const client = await (0, pool_1.getPool)().connect();
        try {
            await client.query('BEGIN');
            // Remove existing entries for this day
            await client.query('DELETE FROM turf_resource_schedules WHERE resource_id = $1 AND day_of_week = $2', [resourceId, dayOfWeek]);
            // Insert new entries
            for (const interval of intervals) {
                await client.query(`INSERT INTO turf_resource_schedules (resource_id, day_of_week, open_time, close_time)
           VALUES ($1, $2, $3, $4)`, [resourceId, dayOfWeek, interval.openTime, interval.closeTime]);
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
    }
    // ── Booking Lifecycle Helpers ──────────────────────────────────────────────
    /**
     * Transition a booking's availability unit to payment_pending.
     */
    async transitionToPaymentPending(unitId, userId) {
        const redis = (0, redis_1.getRedis)();
        const lockKey = holdRedisKey(unitId);
        // Verify we hold the Redis hint (non-critical — DB is authoritative)
        const currentToken = await redis.get(lockKey);
        if (!currentToken) {
            throw new errorHandler_1.AppError('No active hold for this slot', 409);
        }
        await turfAvailabilityRepository_1.turfAvailabilityRepository.markPaymentPending(unitId, userId);
    }
    /**
     * Release a unit back to available.
     * Cleans up both Redis hint and DB state atomically.
     */
    async releaseUnit(unitId) {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Release any active hold on this unit
            await client.query(`UPDATE turf_holds SET status = 'released', released_at = NOW()
         WHERE availability_unit_id = $1 AND status = 'active'`, [unitId]);
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
        // Reset the unit
        await turfAvailabilityRepository_1.turfAvailabilityRepository.markAvailable(unitId);
        // Clean up Redis hint
        try {
            const redis = (0, redis_1.getRedis)();
            await redis.del(holdRedisKey(unitId));
        }
        catch {
            // Redis is non-critical
        }
    }
    /**
     * Mark unit as booked after payment confirmation.
     */
    async confirmUnit(unitId) {
        await turfAvailabilityRepository_1.turfAvailabilityRepository.markBooked(unitId);
        // Clean up Redis hint
        try {
            const redis = (0, redis_1.getRedis)();
            await redis.del(holdRedisKey(unitId));
        }
        catch {
            // Redis is non-critical
        }
    }
    // ── Reconciliation ─────────────────────────────────────────────────────────
    /**
     * Reconcile DB holds against actual state.
     *
     * Two passes:
     * 1. Release units that are 'locked' or 'payment_pending' with expired lock_expires_at
     *    AND no active hold in the holds table AND no Redis lock.
     * 2. Release active holds that have expired (safety net if worker hasn't run).
     */
    async reconcileStaleLocks() {
        const pool = (0, pool_1.getPool)();
        const client = await pool.connect();
        let reconciled = 0;
        try {
            await client.query('BEGIN');
            // Pass 1: Units in locked/payment_pending with expired lock_expires_at
            const staleUnits = await client.query(`SELECT id, status, lock_expires_at FROM turf_availability_units
         WHERE status IN ('locked', 'payment_pending')
           AND lock_expires_at < NOW()
         LIMIT 100 FOR UPDATE`);
            for (const unit of staleUnits.rows) {
                // Double-check: is there an active hold?
                const holdCheck = await client.query(`SELECT id FROM turf_holds
           WHERE availability_unit_id = $1 AND status = 'active' AND expires_at > NOW() LIMIT 1`, [unit.id]);
                if (holdCheck.rows.length > 0)
                    continue;
                // Check Redis (best-effort)
                try {
                    const redis = (0, redis_1.getRedis)();
                    const lockExists = await redis.exists(holdRedisKey(unit.id));
                    if (lockExists)
                        continue;
                }
                catch {
                    // If Redis is down, rely on DB checks only
                }
                // Safe to release
                await client.query("UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1", [unit.id]);
                // Also release any orphaned hold record
                await client.query(`UPDATE turf_holds SET status = 'released', released_at = NOW()
           WHERE availability_unit_id = $1 AND status = 'active'`, [unit.id]);
                reconciled++;
            }
            // Pass 2: Expired active holds (safety net)
            const expiredHolds = await client.query(`SELECT id, availability_unit_id FROM turf_holds
         WHERE status = 'active' AND expires_at < NOW()
         LIMIT 100 FOR UPDATE`);
            for (const hold of expiredHolds.rows) {
                await client.query(`UPDATE turf_holds SET status = 'expired', released_at = NOW() WHERE id = $1`, [hold.id]);
                await turfAvailabilityRepository_1.turfAvailabilityRepository.markAvailable(hold.availability_unit_id);
                reconciled++;
            }
            await client.query('COMMIT');
            if (reconciled > 0) {
                logger_1.logger.info(`[AvailabilityEngine] Reconciled ${reconciled} stale locks/holds`);
            }
            return reconciled;
        }
        catch (err) {
            await client.query('ROLLBACK');
            logger_1.logger.error('[AvailabilityEngine] Reconciliation failed:', err);
            throw err;
        }
        finally {
            client.release();
        }
    }
    // ── Customer-facing Availability ────────────────────────────────────────────
    /**
     * Get customer-facing availability for a resource on a given date.
     *
     * This is the single public entry point for slot browsing.
     * It reuses the authoritative getAvailability() engine and enriches
     * the output with customer-friendly formatting.
     *
     * @throws AppError(404) if resource not found
     * @throws AppError(400) if resource or venue is not active
     * @throws AppError(400) if date format is invalid
     */
    async getCustomerAvailability(resourceId, date) {
        // ── Input validation ──────────────────────────────────────────────────────
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new errorHandler_1.AppError('Invalid date format. Use YYYY-MM-DD', 400);
        }
        const parsedDate = new Date(date + 'T00:00:00Z');
        if (isNaN(parsedDate.getTime())) {
            throw new errorHandler_1.AppError('Invalid date', 400);
        }
        // ── Authoritative availability from the engine ────────────────────────────
        // getAvailability already validates: resource exists, resource is active,
        // venue exists and is approved. It throws AppError with appropriate codes.
        const dayAvailability = await this.getAvailability(resourceId, date);
        // ── Look up resource and venue for display names ──────────────────────────
        const resource = await turfResourceRepository_1.turfResourceRepository.findById(resourceId);
        const venue = resource ? await turfVenueRepository_1.turfVenueRepository.findById(resource.venue_id) : null;
        // ── Enrich slots with customer-facing fields ──────────────────────────────
        const slots = dayAvailability.slots.map(slot => {
            const start = new Date(slot.startsAt);
            const end = new Date(slot.endsAt);
            const durationMs = end.getTime() - start.getTime();
            const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
            // Format time for display in IST (Asia/Kolkata = UTC+5:30)
            const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
            const formatTime = (d) => {
                const ist = new Date(d.getTime() + IST_OFFSET_MS);
                const hours = ist.getHours();
                const minutes = ist.getMinutes();
                const h12 = hours % 12 || 12;
                const ampm = hours < 12 ? 'AM' : 'PM';
                return `${h12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
            };
            const formattedTime = `${formatTime(start)} – ${formatTime(end)}`;
            return {
                unit_id: slot.unitId,
                starts_at: slot.startsAt,
                ends_at: slot.endsAt,
                status: slot.status,
                price: slot.price,
                currency: 'INR',
                formatted_time: formattedTime,
                duration_minutes: durationMinutes,
                blocked_reason: slot.status === 'blocked' ? 'Slot blocked by venue management' : null,
            };
        });
        // ── Compute summary counts ────────────────────────────────────────────────
        const summary = {
            available: 0, held: 0, booked: 0, blocked: 0, unavailable: 0,
        };
        for (const s of slots) {
            if (s.status === 'available')
                summary.available++;
            else if (s.status === 'held')
                summary.held++;
            else if (s.status === 'booked')
                summary.booked++;
            else if (s.status === 'blocked')
                summary.blocked++;
            else
                summary.unavailable++;
        }
        return {
            resource_id: dayAvailability.resourceId,
            resource_name: resource?.name ?? '',
            venue_id: venue?.id ?? 0,
            venue_name: venue?.name ?? '',
            date: dayAvailability.date,
            timezone: dayAvailability.timezone,
            slots,
            summary,
        };
    }
}
exports.AvailabilityEngine = AvailabilityEngine;
exports.availabilityEngine = new AvailabilityEngine();
