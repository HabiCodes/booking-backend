/**
 * Payment order repository — provider-agnostic payment orders.
 *
 * Column naming convention:
 *   provider_payment_id       → gateway-specific payment identifier
 *   provider_order_token       → gateway-specific order token
 *   provider_session_id        → gateway-specific payment session ID
 *   provider_authorization_id  → gateway-specific authorization ID
 *
 * Column names are provider-agnostic (cf_payment_id, etc.).
 */

import { getPool } from '../db/pool';
import { PoolClient } from 'pg';
import { logger } from '../utils/logger';
import type {
  PaymentOrderRow,
  PaymentOrderPublic,
  PaymentOrderStatus,
  PaymentOrderCreateInput,
} from '../types';

export class PaymentOrderRepository {
  async create(input: PaymentOrderCreateInput): Promise<PaymentOrderRow> {
    const { rows } = await getPool().query(
      `INSERT INTO payment_orders (order_id, booking_id, organization_id, event_id, booking_type, amount, currency, idempotency_key, status, payment_gateway, financial_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CREATED',$9,$10)
       RETURNING *`,
      [
        input.order_id,
        input.booking_id,
        input.organization_id,
        input.event_id ?? null,
        input.event_id != null ? 'event' : input.movie_id != null ? 'movie' : 'turf',
        input.amount,
        input.currency || 'INR',
        input.idempotency_key || null,
        input.payment_gateway || 'federal_bank',
        input.financial_snapshot ? JSON.stringify(input.financial_snapshot) : null,
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
      `UPDATE payment_orders SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as PaymentOrderRow[])[0] || null;
  }

  async updateStatusGuarded(id: number, status: PaymentOrderStatus, extra: Record<string, unknown> = {}, client?: PoolClient): Promise<PaymentOrderRow | null> {
    const pool = client ?? getPool();
    const TERMINAL = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
    const sets: string[] = ['status = $1', 'updated_at = NOW()'];
    const params: unknown[] = [status];
    let idx = 2;
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }
    // Only update if the order is NOT already in a terminal state
    // This prevents stale webhooks from downgrading COMPLETED → FAILED, etc.
    const terminalPlaceholders = TERMINAL.map(() => `$${idx++}`).join(',');
    const idPlaceholder = `$${idx++}`;
    const { rows } = await pool.query(
      `UPDATE payment_orders SET ${sets.join(', ')} WHERE id = ${idPlaceholder} AND status NOT IN (${terminalPlaceholders}) RETURNING *`,
      [...params, id, ...TERMINAL]
    );
    const result = (rows as unknown as PaymentOrderRow[])[0] || null;
    if (!result) {
      // Fetch current state to check if terminal (caller may need to know)
      const current = await pool.query('SELECT status FROM payment_orders WHERE id = $1', [id]);
      const currentStatus = current.rows[0]?.status;
      if ((TERMINAL as readonly string[]).includes(currentStatus)) {
        logger.warn('[Payment] Guarded status update blocked — order is terminal', { orderId: id, currentStatus, requestedStatus: status });
      }
    }
    return result;
  }

  async updateFromWebhook(orderId: string, data: Record<string, unknown>, client?: PoolClient): Promise<PaymentOrderRow | null> {
    const pool = client ?? getPool();
    const TERMINAL = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
    const sets: string[] = ['verified_at = NOW()', 'verified_by = \'webhook\'', 'retry_count = retry_count + 1', 'updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (data.status != null) { sets.push(`status = $${++idx}`); params.push(data.status); }
    if (data.provider_payment_id != null) { sets.push(`provider_payment_id = $${++idx}`); params.push(data.provider_payment_id); }
    if (data.provider_authorization_id != null) { sets.push(`provider_authorization_id = $${++idx}`); params.push(data.provider_authorization_id); }
    if (data.payment_method != null) { sets.push(`payment_method = $${++idx}`); params.push(data.payment_method); }
    if (data.provider_session_id != null) { sets.push(`provider_session_id = $${++idx}`); params.push(data.provider_session_id); }
    if (data.provider_order_token != null) { sets.push(`provider_order_token = $${++idx}`); params.push(data.provider_order_token); }
    if (data.error_code != null) { sets.push(`error_code = $${++idx}`); params.push(data.error_code); }
    if (data.error_message != null) { sets.push(`error_message = $${++idx}`); params.push(data.error_message); }

    // GUARD: never overwrite a terminal (final) state.
    // Prevents stale/duplicate webhooks from downgrading COMPLETED→FAILED.
    const idParam = `$${++idx}`;
    const terminalParams = TERMINAL.map((_t, i) => `$${++idx}`);
    const { rows } = await pool.query(
      `UPDATE payment_orders SET ${sets.join(', ')} WHERE order_id = ${idParam} AND status NOT IN (${terminalParams.join(',')}) RETURNING *`,
      [...params, orderId, ...TERMINAL]
    );
    const result = (rows as unknown as PaymentOrderRow[])[0] || null;
    if (!result && pool === getPool()) {
      const current = await getPool().query('SELECT status FROM payment_orders WHERE order_id = $1', [orderId]);
      const currentStatus = current.rows[0]?.status;
      if ((TERMINAL as readonly string[]).includes(currentStatus)) {
        logger.warn('[Payment] Webhook status update blocked — order is terminal', { orderId, currentStatus });
      }
    }
    return result;
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
      `SELECT po.event_id, tt.id as tier_id, tt.name as tier_name, SUM(tt.sold_quantity * tt.price) as revenue, SUM(tt.sold_quantity) as tickets_sold
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
