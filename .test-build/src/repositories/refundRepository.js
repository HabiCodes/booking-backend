"use strict";
/**
 * Refund repository — Cashfree refund records.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.refundRepository = exports.RefundRepository = void 0;
const pool_1 = require("../db/pool");
class RefundRepository {
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO refunds (payment_order_id, booking_id, amount, currency, reason, refund_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
       RETURNING *`, [input.payment_order_id, input.booking_id, input.amount, 'INR', input.reason || null, input.refund_type || 'customer_initiated']);
        return rows[0];
    }
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM refunds WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByPaymentOrderId(paymentOrderId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM refunds WHERE payment_order_id = $1 ORDER BY created_at DESC', [paymentOrderId]);
        return rows;
    }
    async findByBookingId(bookingId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId]);
        return rows;
    }
    async listAll(query) {
        const page = query.page || 1;
        const pageSize = Math.min(query.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const whereClauses = [];
        const params = [];
        let idx = 1;
        if (query.status) {
            whereClauses.push(`r.status = $${idx++}`);
            params.push(query.status);
        }
        if (query.organizationId) {
            whereClauses.push(`po.organization_id = $${idx++}`);
            params.push(query.organizationId);
        }
        const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM refunds r JOIN payment_orders po ON po.id = r.payment_order_id ${where}`, params);
        const total = Number(countRows[0]?.total ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT r.* FROM refunds r JOIN payment_orders po ON po.id = r.payment_order_id ${where} ORDER BY r.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return { items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    async updateStatus(id, status, extra = {}) {
        const sets = ['status = $1', 'updated_at = NOW()'];
        const params = [status];
        let idx = 2;
        for (const [key, value] of Object.entries(extra)) {
            if (value !== undefined) {
                sets.push(`${key} = $${idx++}`);
                params.push(value);
            }
        }
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE refunds SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, [...params, id]);
        return rows[0] || null;
    }
}
exports.RefundRepository = RefundRepository;
const refundRepository = new RefundRepository();
exports.refundRepository = refundRepository;
