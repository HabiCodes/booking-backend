/**
 * Turf settlement service — payout tracking for turf organizations.
 */

import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfSettlementRepository } from '../repositories/turfSettlementRepository';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';

export class TurfSettlementService {
  async createSettlementForBooking(bookingId: number) {
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking || booking.status !== 'confirmed') return;

    const existing = await turfSettlementRepository.findItemByBooking(bookingId);
    if (existing) return;

    const grossAmount = parseFloat(booking.amount);
    const commissionRate = 10;
    const commissionAmount = Math.round((grossAmount * commissionRate) / 100 * 100) / 100;
    const tdsAmount = Math.round((grossAmount * 1) / 100 * 100) / 100;
    const netAmount = Math.round((grossAmount - commissionAmount - tdsAmount) * 100) / 100;

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
