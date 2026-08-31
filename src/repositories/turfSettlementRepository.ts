/**
 * Turf settlement repository.
 */

import { getPool } from '../db/pool';
import type { TurfSettlementRow, TurfSettlementPublic, TurfSettlementItemRow } from '../types';

export class TurfSettlementRepository {
  async findById(id: number): Promise<TurfSettlementRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_settlements WHERE id = $1 LIMIT 1', [id]);
    return (rows as TurfSettlementRow[])[0] || null;
  }

  async findPendingByOrg(orgId?: number): Promise<TurfSettlementRow[]> {
    const whereClause = orgId !== undefined
      ? 'organization_id = $1 AND scheduled_at <= NOW()'
      : '1=1';
    const params = orgId !== undefined ? [orgId] : [];
    const { rows } = await getPool().query(
      `SELECT * FROM turf_settlements WHERE ${whereClause} AND status = 'pending' AND net_amount >= 500 AND retry_count < max_retries AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 20`,
      params
    );
    return rows as TurfSettlementRow[];
  }

  async create(input: Record<string, unknown>): Promise<TurfSettlementRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlements (organization_id, gross_amount, commission_amount, tax_amount, net_amount, scheduled_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.organization_id, input.gross_amount ?? 0, input.commission_amount ?? 0, input.tax_amount ?? 0, input.net_amount ?? 0, input.scheduled_at ?? new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()]
    );
    return rows[0] as TurfSettlementRow;
  }

  async addItem(input: { settlement_id: number; booking_id: number; gross_amount: number; commission_amount: number; tax_amount: number; net_amount: number }): Promise<TurfSettlementItemRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlement_items (settlement_id, booking_id, gross_amount, commission_amount, tax_amount, net_amount) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (booking_id) DO NOTHING RETURNING *`,
      [input.settlement_id, input.booking_id, input.gross_amount, input.commission_amount, input.tax_amount, input.net_amount]
    );
    return (rows as TurfSettlementItemRow[])[0] || null as unknown as TurfSettlementItemRow;
  }

  async findItemByBooking(bookingId: number): Promise<TurfSettlementItemRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_settlement_items WHERE booking_id = $1 LIMIT 1',
      [bookingId]
    );
    return (rows as TurfSettlementItemRow[])[0] || null;
  }

  async findOrCreatePendingSettlement(orgId: number): Promise<TurfSettlementRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlements (organization_id, scheduled_at)
       VALUES ($1, $2)
       ON CONFLICT (organization_id) WHERE status = 'pending'
       DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [orgId, new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()]
    );
    return rows[0] as TurfSettlementRow;
  }

  async incrementRetry(id: number, failureReason: string): Promise<void> {
    await getPool().query(
      'UPDATE turf_settlements SET retry_count = retry_count + 1, failure_reason = $2 WHERE id = $1',
      [id, failureReason]
    );
  }

  async markOnHold(id: number): Promise<void> {
    await getPool().query("UPDATE turf_settlements SET status = 'on_hold' WHERE id = $1", [id]);
  }

  async markProcessing(id: number): Promise<void> {
    await getPool().query("UPDATE turf_settlements SET status = 'processing', updated_at = NOW() WHERE id = $1", [id]);
  }

  async markCompleted(id: number, payoutId: string): Promise<void> {
    await getPool().query(
      "UPDATE turf_settlements SET status = 'completed', gateway_payout_id = $2, completed_at = NOW() WHERE id = $1",
      [id, payoutId]
    );
  }
}

export const turfSettlementRepository = new TurfSettlementRepository();
