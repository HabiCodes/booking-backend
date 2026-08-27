/**
 * Refund repository — payment provider refund records.
 */

import { getPool } from '../db/pool';
import { PoolClient } from 'pg';
import type { RefundRow, RefundPublic, RefundStatus, RefundType, RefundCreateInput } from '../types';

export class RefundRepository {
  async create(input: RefundCreateInput, client?: PoolClient): Promise<RefundRow> {
    const pool = client ?? getPool();
    const { rows } = await pool.query(
      `INSERT INTO refunds (payment_order_id, booking_id, amount, currency, reason, refund_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING')
       RETURNING *`,
      [input.payment_order_id, input.booking_id, input.amount, 'INR', input.reason || null, input.refund_type || 'customer_initiated']
    );
    return rows[0] as unknown as RefundRow;
  }

  async findById(id: number): Promise<RefundRow | null> {
    const { rows } = await getPool().query('SELECT * FROM refunds WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as RefundRow[])[0] || null;
  }

  async findByPaymentOrderId(paymentOrderId: number): Promise<RefundRow[]> {
    const { rows } = await getPool().query('SELECT * FROM refunds WHERE payment_order_id = $1 ORDER BY created_at DESC', [paymentOrderId]);
    return rows as unknown as RefundRow[];
  }

  async findByBookingId(bookingId: number): Promise<RefundRow[]> {
    const { rows } = await getPool().query('SELECT * FROM refunds WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId]);
    return rows as unknown as RefundRow[];
  }

  async listAll(query: { page?: number; pageSize?: number; status?: RefundStatus; organizationId?: number }): Promise<{ items: RefundPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (query.status) { whereClauses.push(`r.status = $${idx++}`); params.push(query.status); }
    if (query.organizationId) { whereClauses.push(`po.organization_id = $${idx++}`); params.push(query.organizationId); }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM refunds r JOIN payment_orders po ON po.id = r.payment_order_id ${where}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT r.* FROM refunds r JOIN payment_orders po ON po.id = r.payment_order_id ${where} ORDER BY r.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as RefundPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async updateStatus(id: number, status: RefundStatus, extra: Record<string, unknown> = {}, client?: PoolClient): Promise<RefundRow | null> {
    const pool = client ?? getPool();
    const sets: string[] = ['status = $1', 'updated_at = NOW()'];
    const params: unknown[] = [status];
    let idx = 2;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        sets.push(`${key} = ${idx++}`);
        params.push(value);
      }
    }
    const { rows } = await pool.query(
      `UPDATE refunds SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as RefundRow[])[0] || null;
  }
}

const refundRepository = new RefundRepository();
export { refundRepository };
