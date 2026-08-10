"use strict";
/**
 * Turf refund repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfRefundRepository = exports.TurfRefundRepository = void 0;
const pool_1 = require("../db/pool");
class TurfRefundRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_refunds WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByBooking(bookingId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_refunds WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId]);
        return rows;
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_refunds (settlement_item_id, booking_id, amount, currency, reason, refund_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [input.settlement_item_id ?? null, input.booking_id, input.amount, input.currency ?? 'INR', input.reason ?? null, input.refund_type ?? 'customer_initiated']);
        return rows[0];
    }
    async updateStatus(id, status, processedAt, gatewayRefundId) {
        const setClauses = ['status = $2', 'updated_at = NOW()'];
        const params = [id, status];
        let idx = 3;
        if (processedAt) {
            setClauses.push(`processed_at = $${idx++}`);
            params.push(processedAt);
        }
        if (gatewayRefundId) {
            setClauses.push(`gateway_refund_id = $${idx++}`);
            params.push(gatewayRefundId);
        }
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE turf_refunds SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`, params);
        return rows[0] || null;
    }
}
exports.TurfRefundRepository = TurfRefundRepository;
exports.turfRefundRepository = new TurfRefundRepository();
