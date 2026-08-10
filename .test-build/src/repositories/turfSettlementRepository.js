"use strict";
/**
 * Turf settlement repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfSettlementRepository = exports.TurfSettlementRepository = void 0;
const pool_1 = require("../db/pool");
class TurfSettlementRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_settlements WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findPendingByOrg(orgId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM turf_settlements WHERE organization_id = $1 AND status = 'pending' AND net_amount >= 500 AND retry_count < max_retries ORDER BY scheduled_at ASC LIMIT 20`, [orgId]);
        return rows;
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_settlements (organization_id, gross_amount, commission_amount, tax_amount, net_amount, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [input.organization_id, input.gross_amount ?? 0, input.commission_amount ?? 0, input.tax_amount ?? 0, input.net_amount ?? 0, input.scheduled_at ?? 'NOW() + INTERVAL \'12 hours\'']);
        return rows[0];
    }
    async addItem(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_settlement_items (settlement_id, booking_id, gross_amount, commission_amount, tax_amount, net_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [input.settlement_id, input.booking_id, input.gross_amount, input.commission_amount, input.tax_amount, input.net_amount]);
        return rows[0];
    }
    async findItemByBooking(bookingId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_settlement_items WHERE booking_id = $1 LIMIT 1', [bookingId]);
        return rows[0] || null;
    }
    async incrementRetry(id, failureReason) {
        await (0, pool_1.getPool)().query('UPDATE turf_settlements SET retry_count = retry_count + 1, failure_reason = $2 WHERE id = $1', [id, failureReason]);
    }
    async markOnHold(id) {
        await (0, pool_1.getPool)().query("UPDATE turf_settlements SET status = 'on_hold' WHERE id = $1", [id]);
    }
    async markProcessing(id) {
        await (0, pool_1.getPool)().query("UPDATE turf_settlements SET status = 'processing', updated_at = NOW() WHERE id = $1", [id]);
    }
    async markCompleted(id, payoutId) {
        await (0, pool_1.getPool)().query("UPDATE turf_settlements SET status = 'completed', gateway_payout_id = $2, completed_at = NOW() WHERE id = $1", [id, payoutId]);
    }
}
exports.TurfSettlementRepository = TurfSettlementRepository;
exports.turfSettlementRepository = new TurfSettlementRepository();
