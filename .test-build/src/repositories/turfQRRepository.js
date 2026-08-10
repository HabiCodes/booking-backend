"use strict";
/**
 * Turf QR ticket repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfQRRepository = exports.TurfQRRepository = void 0;
const pool_1 = require("../db/pool");
class TurfQRRepository {
    async create(bookingId, token) {
        const { rows } = await (0, pool_1.getPool)().query('INSERT INTO turf_qr_tickets (booking_id, token) VALUES ($1, $2) RETURNING *', [bookingId, token]);
        return rows[0];
    }
    async findByToken(token) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_qr_tickets WHERE token = $1 LIMIT 1', [token]);
        return rows[0] || null;
    }
    async findByBooking(bookingId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_qr_tickets WHERE booking_id = $1 LIMIT 1', [bookingId]);
        return rows[0] || null;
    }
    async markUsed(id, usedBy) {
        await (0, pool_1.getPool)().query("UPDATE turf_qr_tickets SET status = 'used', used_at = NOW(), used_by = $2 WHERE id = $1 AND status = 'issued'", [id, usedBy]);
    }
    async revokeByBooking(bookingId) {
        await (0, pool_1.getPool)().query("UPDATE turf_qr_tickets SET status = 'revoked' WHERE booking_id = $1 AND status = 'issued'", [bookingId]);
    }
}
exports.TurfQRRepository = TurfQRRepository;
exports.turfQRRepository = new TurfQRRepository();
