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

import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfSettlementRepository } from '../repositories/turfSettlementRepository';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';
import { financialConfigService } from './financialConfigService';
import { calculateBookingFinancials, rupeesToPaise, paiseToRupees } from './financialCalculator';

// Conversion: percent (e.g. 10 for 10%) → basis points.
const percentToBps = (percent: number): number => Math.round(percent * 100);

export class TurfSettlementService {
  async createSettlementForBooking(bookingId: number) {
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking || booking.status !== 'confirmed') return;

    const existing = await turfSettlementRepository.findItemByBooking(bookingId);
    if (existing) return;

    const grossAmount = parseFloat(booking.amount);
    const grossAmountPaise = rupeesToPaise(grossAmount);

    // Resolve commission and TDS from the single source of truth.
    const orgCommissionResult = await getPool().query(
      'SELECT commission_rate FROM organizations WHERE id = $1',
      [booking.organization_id]
    );
    const orgCommissionPercent = parseFloat(orgCommissionResult.rows[0]?.commission_rate ?? '10');
    const orgCommissionBps = percentToBps(orgCommissionPercent);

    const configSnapshot = await financialConfigService.getSnapshot(booking.organization_id);
    // Compose a snapshot that respects org-level commission while pulling TDS/other rates
    // from the financial_configs table.
    const composedConfig = {
      ...configSnapshot,
      commission_bps: orgCommissionBps,
    };

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: composedConfig,
    });

    // Convert paise back to the existing rupees-with-2dp convention that the
    // turf_settlement_items columns expect (preserves DB contract + rounding).
    const commissionAmount = parseFloat(paiseToRupees(breakdown.commission_paise));
    const tdsAmount = parseFloat(paiseToRupees(breakdown.tds_paise));
    const netAmount = parseFloat(paiseToRupees(breakdown.net_payable_to_business_paise));

    const pendingList = await turfSettlementRepository.findPendingByOrg(booking.organization_id);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await turfSettlementRepository.create({ organization_id: booking.organization_id });
    }

    await turfSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: bookingId,
      gross_amount: grossAmount,
      commission_amount: commissionAmount,
      tax_amount: tdsAmount,
      net_amount: netAmount,
    });

    logger.info(`[TurfSettlement] Booking ${bookingId} → settlement ${settlement.id}, net: ${netAmount}`);
  }

  async processDueSettlements() {
    const allSettlements = await turfSettlementRepository.findPendingByOrg(0);
    let processed = 0, failed = 0;
    for (const s of allSettlements) {
      try {
        await turfSettlementRepository.markProcessing(s.id);
        const payoutId = `turf_payout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await turfSettlementRepository.markCompleted(s.id, payoutId);
        processed++;
      } catch (err) {
        failed++;
        await turfSettlementRepository.incrementRetry(s.id, (err as Error).message);
        if (s.retry_count + 1 >= s.max_retries) {
          await turfSettlementRepository.markOnHold(s.id);
        }
      }
    }
    return { processed, failed };
  }

  async listByOrganization(orgId: number, filters: { status?: string; page?: number; pageSize?: number }) {
    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 20, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['organization_id = $1'];
    const params: unknown[] = [orgId];
    let idx = 2;
    if (filters.status) { where.push(`status = $${idx++}`); params.push(filters.status); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_settlements ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount, status, gateway_payout_id, scheduled_at, completed_at, retry_count, created_at, updated_at FROM turf_settlements ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: (rows as any[]).map(r => ({ ...r, gross_amount: parseFloat(r.gross_amount), commission_amount: parseFloat(r.commission_amount), tax_amount: parseFloat(r.tax_amount), net_amount: parseFloat(r.net_amount) })),
      total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1,
    };
  }
}

export const turfSettlementService = new TurfSettlementService();
