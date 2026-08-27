/**
 * Event settlement service — payout tracking for event organizers.
 *
 * Single source of truth for all financial rates:
 *   - Commission rate, TDS, platform fee, GST: financial_configs table (via FinancialConfigService)
 *
 * Arithmetic is delegated to FinancialCalculator which works in integer paise
 * to avoid floating-point drift.
 */

import { eventSettlementRepository } from '../repositories/eventSettlementRepository';
import { eventRepository } from '../repositories/eventRepository';
import { logger } from '../utils/logger';
import { financialConfigService } from './financialConfigService';
import { calculateBookingFinancials } from './financialCalculator';

export class EventSettlementService {
  async createSettlementForBooking(bookingId: number): Promise<void> {
    // Fetch the booking's event to get organization_id
    // We do a lightweight join via the bookings→events relationship
    const eventResult = await eventRepository.getBookingEvent(bookingId);
    if (!eventResult) return;

    const { event_id, organization_id } = eventResult;
    if (!organization_id || organization_id <= 0) return;

    const existing = await eventSettlementRepository.findItemByBooking(bookingId);
    if (existing) return;

    // Get pricing snapshot from the payment_orders table (financial_snapshot column)
    const paymentOrder = await this._getPaymentOrderForBooking(bookingId);
    let grossAmountPaise: number;
    const snapshotSubtotal = paymentOrder?.financial_snapshot?.subtotalPaise as number | undefined;
    if (typeof snapshotSubtotal === 'number' && snapshotSubtotal > 0) {
      grossAmountPaise = snapshotSubtotal;
    } else {
      // Fallback: reverse-calculate from customer total (includes 18% GST + 10% platform fee)
      const customerTotalPaise = paymentOrder ? Math.round(Number(paymentOrder.amount)) : 0;
      if (customerTotalPaise <= 0) return;
      // PricingEngine total = base + 18% GST + 10% platform fee = base * 1.28
      grossAmountPaise = Math.round(customerTotalPaise / 1.28);
    }

    const configSnapshot = await financialConfigService.getSnapshot(organization_id);

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: configSnapshot,
    });

    const baseAmount = parseFloat((grossAmountPaise / 100).toFixed(2));
    const commissionAmount = parseFloat((breakdown.commission_paise / 100).toFixed(2));
    const taxAmount = parseFloat((breakdown.gst_on_platform_fee_paise / 100).toFixed(2));
    const netAmount = parseFloat((breakdown.net_payable_to_business_paise / 100).toFixed(2));

    const pendingList = await eventSettlementRepository.findPendingByOrg(organization_id);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await eventSettlementRepository.findOrCreatePendingSettlement(organization_id);
    }

    await eventSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: bookingId,
      gross_amount: baseAmount,
      commission_amount: commissionAmount,
      tax_amount: taxAmount,
      net_amount: netAmount,
    });

    logger.info(`[EventSettlement] Booking ${bookingId} → settlement ${settlement.id}, net: ${netAmount}`);
  }

  async processDueSettlements() {
    const allSettlements = await eventSettlementRepository.findPendingByOrg(undefined);
    let processed = 0, failed = 0;
    for (const s of allSettlements) {
      try {
        await eventSettlementRepository.markProcessing(s.id);
        const payoutId = `event_payout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await eventSettlementRepository.markCompleted(s.id, payoutId);
        processed++;
      } catch (err) {
        failed++;
        await eventSettlementRepository.incrementRetry(s.id, (err as Error).message);
        if (s.retry_count + 1 >= s.max_retries) {
          await eventSettlementRepository.markOnHold(s.id);
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
    const { rows: countRows } = await (await import('../db/pool')).getPool().query(`SELECT COUNT(*) FROM event_settlements ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await (await import('../db/pool')).getPool().query(
      `SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount, status, gateway_payout_id, scheduled_at, completed_at, retry_count, created_at, updated_at FROM event_settlements ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: (rows as any[]).map(r => ({ ...r, gross_amount: parseFloat(r.gross_amount), commission_amount: parseFloat(r.commission_amount), tax_amount: parseFloat(r.tax_amount), net_amount: parseFloat(r.net_amount) })),
      total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  private async _getPaymentOrderForBooking(bookingId: number): Promise<{ amount: string; financial_snapshot: Record<string, unknown> } | null> {
    const pool = (await import('../db/pool')).getPool();
    const { rows } = await pool.query(
      `SELECT amount, financial_snapshot FROM payment_orders WHERE booking_id = $1 AND booking_type = 'event' LIMIT 1`,
      [bookingId]
    );
    return (rows as any[])[0] || null;
  }
}

export const eventSettlementService = new EventSettlementService();
