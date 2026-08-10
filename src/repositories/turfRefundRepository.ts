/**
 * Turf refund repository.
 */

import { getPool } from '../db/pool';
import type { TurfRefundRow, TurfRefundPublic } from '../types';

export class TurfRefundRepository {
  async findById(id: number): Promise<TurfRefundRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_refunds WHERE id = $1 LIMIT 1', [id]);
    return (rows as TurfRefundRow[])[0] || null;
  }

  async findByBooking(bookingId: number): Promise<TurfRefundRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_refunds WHERE booking_id = $1 ORDER BY created_at DESC',
      [bookingId]
    );
    return rows as TurfRefundRow[];
  }

  async create(input: Record<string, unknown>): Promise<TurfRefundRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_refunds (settlement_item_id, booking_id, amount, currency, reason, refund_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.settlement_item_id ?? null, input.booking_id, input.amount, input.currency ?? 'INR', input.reason ?? null, input.refund_type ?? 'customer_initiated']
    );
    return rows[0] as TurfRefundRow;
  }

  async updateStatus(id: number, status: string, processedAt?: string | null, gatewayRefundId?: string | null): Promise<TurfRefundRow | null> {
    const setClauses = ['status = $2', 'updated_at = NOW()'];
    const params: unknown[] = [id, status];
    let idx = 3;
    if (processedAt) { setClauses.push(`processed_at = $${idx++}`); params.push(processedAt); }
    if (gatewayRefundId) { setClauses.push(`gateway_refund_id = $${idx++}`); params.push(gatewayRefundId); }
    const { rows } = await getPool().query(
      `UPDATE turf_refunds SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    return (rows as TurfRefundRow[])[0] || null;
  }
}

export const turfRefundRepository = new TurfRefundRepository();
