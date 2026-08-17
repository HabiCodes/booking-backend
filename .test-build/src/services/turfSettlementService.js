"use strict";
/**
 * Turf settlement service — payout tracking for turf organizations.
 *
 * Single source of truth for all financial rates:
 *   - Commission rate: organizations.commission_rate (overridable per-org)
 *   - TDS rate, platform fee, GST: financial_configs table (via FinancialConfigService)
 *
 * Arithmetic is delegated to FinancialCalculator which works in integer paise
 * to avoid floating-point drift.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfSettlementService = exports.TurfSettlementService = void 0;
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const turfSettlementRepository_1 = require("../repositories/turfSettlementRepository");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
const financialConfigService_1 = require("./financialConfigService");
const financialCalculator_1 = require("./financialCalculator");
// Conversion: percent (e.g. 10 for 10%) → basis points.
const percentToBps = (percent) => Math.round(percent * 100);
class TurfSettlementService {
    async createSettlementForBooking(bookingId) {
        const booking = await turfBookingRepository_1.turfBookingRepository.findById(bookingId);
        if (!booking || booking.status !== 'confirmed')
            return;
        const existing = await turfSettlementRepository_1.turfSettlementRepository.findItemByBooking(bookingId);
        if (existing)
            return;
        const grossAmount = parseFloat(booking.amount);
        const grossAmountPaise = (0, financialCalculator_1.rupeesToPaise)(grossAmount);
        // Resolve commission and TDS from the single source of truth.
        const orgCommissionResult = await (0, pool_1.getPool)().query('SELECT commission_rate FROM organizations WHERE id = $1', [booking.organization_id]);
        const orgCommissionPercent = parseFloat(orgCommissionResult.rows[0]?.commission_rate ?? '10');
        const orgCommissionBps = percentToBps(orgCommissionPercent);
        const configSnapshot = await financialConfigService_1.financialConfigService.getSnapshot(booking.organization_id);
        // Compose a snapshot that respects org-level commission while pulling TDS/other rates
        // from the financial_configs table.
        const composedConfig = {
            ...configSnapshot,
            commission_bps: orgCommissionBps,
        };
        const breakdown = (0, financialCalculator_1.calculateBookingFinancials)({
            gross_amount_paise: grossAmountPaise,
            config: composedConfig,
        });
        // Convert paise back to the existing rupees-with-2dp convention that the
        // turf_settlement_items columns expect (preserves DB contract + rounding).
        const commissionAmount = parseFloat((0, financialCalculator_1.paiseToRupees)(breakdown.commission_paise));
        const tdsAmount = parseFloat((0, financialCalculator_1.paiseToRupees)(breakdown.tds_paise));
        const netAmount = parseFloat((0, financialCalculator_1.paiseToRupees)(breakdown.net_payable_to_business_paise));
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
