/**
 * Turf settlement service — payout tracking for turf organizations.
 *
 * Single source of truth for all financial rates:
 *   - Commission rate, TDS, platform fee, GST: financial_configs table (via FinancialConfigService)
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

export class TurfSettlementService {
  async createSettlementForBooking(bookingId: number) {
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking || booking.status !== 'confirmed') return;

    const existing = await turfSettlementRepository.findItemByBooking(bookingId);
    if (existing) return;

    // booking.amount is the CUSTOMER TOTAL (base + GST + platform fee).
    // Extract the base subtotal from the pricingSnapshot stored in booking metadata.
    // Fallback: reverse-calculate from total using known 18% GST + ₹50 flat.
    const snapshot = booking.metadata?.pricingSnapshot as
      | { subtotalPaise?: number }
      | undefined;
    let grossAmountPaise: number;
    if (snapshot?.subtotalPaise && snapshot.subtotalPaise > 0) {
      grossAmountPaise = snapshot.subtotalPaise;
    } else {
      grossAmountPaise = Math.round((parseFloat(booking.amount) * 100 - 5000) / 1.18);
    }

    // All rates come from the single source of truth.
    const configSnapshot = await financialConfigService.getSnapshot(booking.organization_id);

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: configSnapshot,
    });

    // Convert paise back to the existing rupees-with-2dp convention that the
    // turf_settlement_items columns expect (preserves DB contract + rounding).
    const commissionAmount = parseFloat(paiseToRupees(breakdown.commission_paise));
    const gstAmount = parseFloat(paiseToRupees(breakdown.gst_on_platform_fee_paise));
    const tdsAmount = parseFloat(paiseToRupees(breakdown.tds_paise));
    const netAmount = parseFloat(paiseToRupees(breakdown.net_payable_to_business_paise));

    const pendingList = await turfSettlementRepository.findPendingByOrg(booking.organization_id);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await turfSettlementRepository.findOrCreatePendingSettlement(booking.organization_id);
    }

    const baseAmount = parseFloat((grossAmountPaise / 100).toFixed(2));

    await turfSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: bookingId,
      gross_amount: baseAmount,
      commission_amount: commissionAmount,
      tax_amount: gstAmount,
      net_amount: netAmount,
    });

    logger.info(`[TurfSettlement] Booking ${bookingId} → settlement ${settlement.id}, net: ${netAmount}`);
  }

  async processDueSettlements() {
    const allSettlements = await turfSettlementRepository.findPendingByOrg(undefined);
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
