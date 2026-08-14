/**
 * Cancellation request repository — the immutable financial decision for a booking.
 *
 * Phase 1: create frozen snapshot, approve/reject, transition to READY_FOR_MANUAL_PAYMENT,
 *          record manual payment and transition to PAID.
 * Phase 2 (future): linkRefund() will set the FK once refunds row is created.
 *
 * CONCURRENCY MODEL:
 *   Every state-changing method (approve, reject, transitionToReadyForPayment,
 *   markAsPaid) MUST be called with a PoolClient from withTransaction().
 *   Inside the transaction the calling service should first call findByIdForUpdate()
 *   which performs SELECT … FOR UPDATE, then verify the expected status, then call
 *   the update method. This ensures two concurrent admins cannot both transition
 *   the row past PENDING / APPROVED / READY_FOR_MANUAL_PAYMENT.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/pool';
import type {
  CancellationRequestRow,
  CancellationRequestCreateInput,
  CancellationRequestStatus,
  CancellationApprovalInput,
  CancellationRejectionInput,
  MarkManualPaymentInput,
} from '../types';

type Executor = ReturnType<typeof getPool> | PoolClient;

const getExecutor = (client?: PoolClient): Executor => client ?? getPool();

function toInt(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return parseInt(v, 10);
  return v;
}

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return parseFloat(v);
  return v;
}

export class CancellationRequestRepository {
  async create(
    input: CancellationRequestCreateInput,
    client: PoolClient
  ): Promise<CancellationRequestRow> {
    // Caller MUST pass a PoolClient from withTransaction().
    // INSERTs go through the same transaction that validated the booking.
    const { rows } = await client.query(
      `INSERT INTO cancellation_requests (
         booking_id, payment_order_id, organization_id,
         requested_by, reason,
         hours_before_event, policy_id,
         calculated_refund_percentage, calculated_refund_amount_paise,
         status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
       RETURNING *`,
      [
        input.booking_id,
        input.payment_order_id,
        input.organization_id,
        input.requested_by,
        input.reason ?? null,
        input.hours_before_event,
        input.policy_id,
        input.calculated_refund_percentage,
        input.calculated_refund_amount_paise,
      ]
    );
    return (rows as unknown as CancellationRequestRow[])[0];
  }

  async findById(id: number, client?: PoolClient): Promise<CancellationRequestRow | null> {
    const { rows } = await getExecutor(client).query(
      `SELECT * FROM cancellation_requests WHERE id = $1 LIMIT 1`,
      [id]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  /**
   * Locks the cancellation_requests row for update. Must be called inside
   * withTransaction(). Use this as the FIRST read in any state-changing
   * operation to guarantee serialization of concurrent updates.
   */
  async findByIdForUpdate(
    id: number,
    client: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await client.query(
      `SELECT * FROM cancellation_requests WHERE id = $1 FOR UPDATE`,
      [id]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  async findByBookingId(
    bookingId: number,
    client?: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await getExecutor(client).query(
      `SELECT * FROM cancellation_requests WHERE booking_id = $1 LIMIT 1`,
      [bookingId]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  /**
   * PENDING → APPROVED.
   * Caller MUST hold the FOR UPDATE row lock and verify status first.
   */
  async approve(
    id: number,
    approval: CancellationApprovalInput,
    approvedPercentage: number,
    approvedAmountPaise: number,
    client: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await client.query(
      `UPDATE cancellation_requests
          SET status = 'APPROVED',
              approved_by_admin_id = $2,
              approved_at = NOW(),
              approved_refund_percentage = $3,
              approved_refund_amount_paise = $4,
              override_reason = $5,
              updated_at = NOW()
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *`,
      [
        id,
        approval.admin_id,
        approvedPercentage,
        approvedAmountPaise,
        approval.override_reason ?? null,
      ]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  /**
   * PENDING → REJECTED.
   * Caller MUST hold the FOR UPDATE row lock and verify status first.
   */
  async reject(
    id: number,
    input: CancellationRejectionInput,
    client: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await client.query(
      `UPDATE cancellation_requests
          SET status = 'REJECTED',
              approved_by_admin_id = $2,
              approved_at = NOW(),
              approved_refund_percentage = 0,
              approved_refund_amount_paise = 0,
              rejection_reason = $3,
              updated_at = NOW()
        WHERE id = $1
          AND status = 'PENDING'
        RETURNING *`,
      [id, input.admin_id, input.rejection_reason ?? null]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  /**
   * APPROVED → READY_FOR_MANUAL_PAYMENT.
   * Caller MUST hold the FOR UPDATE row lock and verify status first.
   */
  async transitionToReadyForPayment(
    id: number,
    client: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await client.query(
      `UPDATE cancellation_requests
          SET status = 'READY_FOR_MANUAL_PAYMENT',
              updated_at = NOW()
        WHERE id = $1
          AND status = 'APPROVED'
        RETURNING *`,
      [id]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  /**
   * READY_FOR_MANUAL_PAYMENT → PAID. Must be called inside the same
   * transaction as the manual_payments INSERT so that the state transition
   * and the payment record are committed atomically.
   */
  async markAsPaid(
    id: number,
    client: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await client.query(
      `UPDATE cancellation_requests
          SET status = 'PAID',
              updated_at = NOW()
        WHERE id = $1
          AND status = 'READY_FOR_MANUAL_PAYMENT'
        RETURNING *`,
      [id]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  async listAll(query: {
    organizationId?: number;
    status?: CancellationRequestStatus;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: CancellationRequestRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (query.organizationId) {
      whereClauses.push(`organization_id = $${idx++}`);
      params.push(query.organizationId);
    }
    if (query.status) {
      whereClauses.push(`status = $${idx++}`);
      params.push(query.status);
    }
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM cancellation_requests ${where}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM cancellation_requests ${where}
         ORDER BY created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: rows as unknown as CancellationRequestRow[],
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  // Phase 2 will use this to link a freshly created refunds row.
  async linkRefund(
    id: number,
    refundId: number | null,
    client?: PoolClient
  ): Promise<CancellationRequestRow | null> {
    const { rows } = await getExecutor(client).query(
      `UPDATE cancellation_requests
          SET refund_id = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, refundId]
    );
    return (rows as unknown as CancellationRequestRow[])[0] || null;
  }

  // Numeric helpers — convert pg NUMERIC strings to JS numbers
  static hoursBeforeEvent(row: CancellationRequestRow): number {
    return toNum(row.hours_before_event) ?? 0;
  }
  static calculatedPercentage(row: CancellationRequestRow): number {
    return toNum(row.calculated_refund_percentage) ?? 0;
  }
  static calculatedAmountPaise(row: CancellationRequestRow): number {
    return toInt(row.calculated_refund_amount_paise) ?? 0;
  }
  static approvedPercentage(row: CancellationRequestRow): number | null {
    return toNum(row.approved_refund_percentage);
  }
  static approvedAmountPaise(row: CancellationRequestRow): number | null {
    return toInt(row.approved_refund_amount_paise);
  }
}

const cancellationRequestRepository = new CancellationRequestRepository();
export { cancellationRequestRepository };
