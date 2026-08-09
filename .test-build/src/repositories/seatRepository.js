"use strict";
/**
 * Seat repository — individual seat management for reserved seating events.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.seatRepository = exports.SeatRepository = void 0;
const pool_1 = require("../db/pool");
class SeatRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM seats WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByEvent(eventId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM seats WHERE event_id = $1 ORDER BY section, row_label, seat_number', [eventId]);
        return rows;
    }
    async findAvailableByEvent(eventId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM seats WHERE event_id = $1 AND is_available = true ORDER BY section, row_label, seat_number', [eventId]);
        return rows;
    }
    async findByEventAndTier(eventId, tierId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM seats WHERE event_id = $1 AND tier_id = $2 ORDER BY section, row_label, seat_number', [eventId, tierId]);
        return rows;
    }
    async findBySection(eventId, section) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM seats WHERE event_id = $1 AND section = $2 ORDER BY row_label, seat_number', [eventId, section]);
        return rows;
    }
    async bulkCreate(eventId, bulk, tierId) {
        const seats = [];
        for (const rowGroup of bulk.rows) {
            for (const seatNum of rowGroup.seat_numbers) {
                const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO seats (event_id, tier_id, section, row_label, seat_number, seat_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [eventId, tierId ?? null, bulk.section, rowGroup.row_label, seatNum, rowGroup.seat_type || 'standard']);
                seats.push(...rows);
            }
        }
        return seats;
    }
    async markAvailable(ids, available) {
        await (0, pool_1.getPool)().query('UPDATE seats SET is_available = $1 WHERE id = ANY($2::int[])', [available, ids]);
    }
    async holdSeats(seatIds, bookingId, expiresMinutes) {
        const expiresAt = new Date(Date.now() + expiresMinutes * 60000).toISOString();
        await (0, pool_1.getPool)().query('UPDATE seats SET is_held = true, hold_expires_at = $1, hold_booking_id = $2 WHERE id = ANY($3::int[])', [expiresAt, bookingId, seatIds]);
    }
    async releaseHold(bookingId) {
        await (0, pool_1.getPool)().query('UPDATE seats SET is_held = false, hold_expires_at = NULL, hold_booking_id = NULL WHERE hold_booking_id = $1', [bookingId]);
    }
    async reserveSeats(seatIds) {
        await (0, pool_1.getPool)().query('UPDATE seats SET is_reserved = true, is_available = false, is_held = false WHERE id = ANY($1::int[])', [seatIds]);
    }
    async clearExpiredHolds() {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE seats SET is_held = false, hold_expires_at = NULL, hold_booking_id = NULL WHERE is_held = true AND hold_expires_at < NOW() RETURNING id`);
        return rows.length;
    }
    async deleteByEvent(eventId) {
        await (0, pool_1.getPool)().query('DELETE FROM seats WHERE event_id = $1', [eventId]);
    }
}
exports.SeatRepository = SeatRepository;
exports.seatRepository = new SeatRepository();
