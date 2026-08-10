"use strict";
/**
 * Turf settlement service — payout tracking for turf organizations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfSettlementService = exports.TurfSettlementService = void 0;
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const turfSettlementRepository_1 = require("../repositories/turfSettlementRepository");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
class TurfSettlementService {
    async createSettlementForBooking(bookingId) {
        const booking = await turfBookingRepository_1.turfBookingRepository.findById(bookingId);
        if (!booking || booking.status !== 'confirmed')
            return;
        const existing = await turfSettlementRepository_1.turfSettlementRepository.findItemByBooking(bookingId);
        if (existing)
            return;
        const grossAmount = parseFloat(booking.amount);
        const commissionRate = 10;
        const commissionAmount = Math.round((grossAmount * commissionRate) / 100 * 100) / 100;
        const tdsAmount = Math.round((grossAmount * 1) / 100 * 100) / 100;
        const netAmount = Math.round((grossAmount - commissionAmount - tdsAmount) * 100) / 100;
        const pendingList = await turfSettlementRepository_1.turfSettlementRepository.findPendingByOrg(booking.organization_id);
        let settlement = pendingList[0];
        if (!settlement) {
            settlement = await turfSettlementRepository_1.turfSettlementRepository.create({ organization_id: booking.organization_id });
        }
        await turfSettlementRepository_1.turfSettlementRepository.addItem({
            settlement_id: settlement.id,
            booking_id: bookingId,
            gross_amount: grossAmount,
            commission_amount: commissionAmount,
            tax_amount: tdsAmount,
            net_amount: netAmount,
        });
        logger_1.logger.info(`[TurfSettlement] Booking ${bookingId} → settlement ${settlement.id}, net: ${netAmount}`);
    }
    async processDueSettlements() {
        const allSettlements = await turfSettlementRepository_1.turfSettlementRepository.findPendingByOrg(0);
        let processed = 0, failed = 0;
        for (const s of allSettlements) {
            try {
                await turfSettlementRepository_1.turfSettlementRepository.markProcessing(s.id);
                const payoutId = `turf_payout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                await turfSettlementRepository_1.turfSettlementRepository.markCompleted(s.id, payoutId);
                processed++;
            }
            catch (err) {
                failed++;
                await turfSettlementRepository_1.turfSettlementRepository.incrementRetry(s.id, err.message);
                if (s.retry_count + 1 >= s.max_retries) {
                    await turfSettlementRepository_1.turfSettlementRepository.markOnHold(s.id);
                }
            }
        }
        return { processed, failed };
    }
    async listByOrganization(orgId, filters) {
        const page = filters.page || 1;
        const pageSize = Math.min(filters.pageSize || 20, 100);
        const offset = (page - 1) * pageSize;
        const where = ['organization_id = $1'];
        const params = [orgId];
        let idx = 2;
        if (filters.status) {
            where.push(`status = $${idx++}`);
            params.push(filters.status);
        }
        const whereStr = `WHERE ${where.join(' AND ')}`;
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) FROM turf_settlements ${whereStr}`, params);
        const total = Number(countRows[0]?.count ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount, status, gateway_payout_id, scheduled_at, completed_at, retry_count, created_at, updated_at FROM turf_settlements ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return {
            items: rows.map(r => ({ ...r, gross_amount: parseFloat(r.gross_amount), commission_amount: parseFloat(r.commission_amount), tax_amount: parseFloat(r.tax_amount), net_amount: parseFloat(r.net_amount) })),
            total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1,
        };
    }
}
exports.TurfSettlementService = TurfSettlementService;
exports.turfSettlementService = new TurfSettlementService();
