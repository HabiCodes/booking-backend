/**
 * Payment order repository — Cashfree payment orders.
 */

import { getPool } from '../db/pool';
import { PoolClient } from 'pg';
import type {
  PaymentOrderRow,
  PaymentOrderPublic,
  PaymentOrderStatus,
  PaymentOrderCreateInput,
} from '../types';

export class PaymentOrderRepository {
  async create(input: PaymentOrderCreateInput): Promise<PaymentOrderRow> {
    const { rows } = await getPool().query(
      `INSERT INTO payment_orders (order_id, booking_id, organization_id, event_id, booking_type, amount, currency, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED')
       RETURNING *`,
      [
        input.order_id,
        input.booking_id,
        input.organization_id,
        input.event_id ?? null,
        input.event_id != null ? 'event' : 'turf',
        input.amount,
        input.currency || 'INR',
        input.idempotency_key || null,
      ]
    );
    return rows[0] as unknown as PaymentOrderRow;
  }

  async findById(id: number): Promise<PaymentOrderRow | null> {
    const { rows } = await getPool().query('SELECT * FROM payment_orders WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async findByOrderId(orderId: string): Promise<PaymentOrderRow | null> {
    const { rows } = await getPool().query('SELECT * FROM payment_orders WHERE order_id = $1 LIMIT 1', [orderId]);
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async findByBookingId(bookingId: number): Promise<PaymentOrderRow | null> {
    const { rows } = await getPool().query('SELECT * FROM payment_orders WHERE booking_id = $1 ORDER BY id DESC LIMIT 1', [bookingId]);
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async findByIdempotencyKey(key: string): Promise<PaymentOrderRow | null> {
    const { rows } = await getPool().query('SELECT * FROM payment_orders WHERE idempotency_key = $1 LIMIT 1', [key]);
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async findByOrganization(organizationId: number, query: { page?: number; pageSize?: number; status?: PaymentOrderStatus }): Promise<{ items: PaymentOrderPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ['organization_id = $1'];
    const params: unknown[] = [organizationId];
    let idx = 2;
    if (query.status) { whereClauses.push(`status = $${idx++}`); params.push(query.status); }
    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) as total FROM payment_orders WHERE ${where}`, params);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM payment_orders WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as PaymentOrderPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async updateStatus(id: number, status: PaymentOrderStatus, extra: Record<string, unknown> = {}, client?: PoolClient): Promise<PaymentOrderRow | null> {
    const pool = client ?? getPool();
    const sets: string[] = ['status = $1', 'updated_at = NOW()'];
    const params: unknown[] = [status];
    let idx = 2;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }
    const { rows } = await pool.query(
      `UPDATE payment_orders SET ${sets.join(', ')} WHERE id = ${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async updateFromWebhook(orderId: string, data: Record<string, unknown>, client?: PoolClient): Promise<PaymentOrderRow | null> {
    const pool = client ?? getPool();
    const { rows } = await pool.query(
      `UPDATE payment_orders SET status = COALESCE($1, status), cf_payment_id = COALESCE($2, cf_payment_id),
              cf_authorization_id = COALESCE($3, cf_authorization_id), payment_method = COALESCE($4, payment_method),
              error_code = COALESCE($5, error_code), error_message = COALESCE($6, error_message),
              verified_at = NOW(), verified_by = 'webhook', retry_count = retry_count + 1, updated_at = NOW()
       WHERE order_id = $7 RETURNING *`,
      [data.status, data.cf_payment_id, data.cf_authorization_id, data.payment_method, data.error_code, data.error_message, orderId]
    );
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async linkBooking(orderId: string, bookingId: number): Promise<void> {
    await getPool().query('UPDATE payment_orders SET booking_id = $1, updated_at = NOW() WHERE order_id = $2', [bookingId, orderId]);
  }

  async deleteExpired(orderId: string): Promise<boolean> {
    const result = await getPool().query('DELETE FROM payment_orders WHERE order_id = $1 AND status = $2', [orderId, 'CREATED']);
    return (result.rowCount || 0) > 0;
  }

  async getRevenueByEvent(organizationId: number, startDate?: string, endDate?: string): Promise<Array<{ event_id: number; event_title: string; revenue: string; booking_count: number }>> {
    const where: string[] = ['po.organization_id = $1', 'po.status IN ($2, $3)'];
    const params: unknown[] = [organizationId, 'COMPLETED', 'PARTIALLY_REFUNDED'];
    let idx = 4;
    if (startDate) { where.push(`po.created_at >= $${idx++}`); params.push(startDate); }
    if (endDate) { where.push(`po.created_at < $${idx++}`); params.push(endDate); }
    const { rows } = await getPool().query(
      `SELECT po.event_id, e.title as event_title, SUM(po.amount) as revenue, COUNT(DISTINCT po.booking_id) as booking_count
       FROM payment_orders po JOIN events e ON e.id = po.event_id
       WHERE ${where.join(' AND ')}
       GROUP BY po.event_id, e.title ORDER BY revenue DESC`,
      params
    );
    return rows as Array<{ event_id: number; event_title: string; revenue: string; booking_count: number }>;
  }

  async getRevenueByTier(organizationId: number, eventId?: number): Promise<Array<{ tier_id: number; tier_name: string; revenue: string; tickets_sold: number }>> {
    const where: string[] = ['po.organization_id = $1', 'po.status IN ($2, $3)'];
    const params: unknown[] = [organizationId, 'COMPLETED', 'PARTIALLY_REFUNDED'];
    let idx = 4;
    if (eventId) { where.push(`po.event_id = $${idx++}`); params.push(eventId); }
    const { rows } = await getPool().query(
      `SELECT tt.id as tier_id, tt.name as tier_name, SUM(tt.sold_quantity * tt.price) as revenue, SUM(tt.sold_quantity) as tickets_sold
       FROM payment_orders po
       JOIN ticket_tiers tt ON tt.event_id = po.event_id
       WHERE ${where.join(' AND ')}
       GROUP BY tt.id, tt.name ORDER BY revenue DESC`,
      params
    );
    return rows as Array<{ tier_id: number; tier_name: string; revenue: string; tickets_sold: number }>;
  }
}

const paymentOrderRepository = new PaymentOrderRepository();
export { paymentOrderRepository };
