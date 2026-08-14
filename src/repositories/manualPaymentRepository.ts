/**
 * Manual Payment repository — records admin-recorded UPI / manual transfers
 * against an approved cancellation request.
 *
 * Each cancellation_request_id may have AT MOST one manual_payments row
 * (enforced by the UNIQUE INDEX uq_manual_payments_request at the database
 * level — see migration 030).
 *
 * All write methods REQUIRE a PoolClient so that inserts and the parent
 * cancellation_requests status transition commit atomically.
 */

import type { PoolClient } from 'pg';
import type { ManualPaymentRow, ManualPaymentCreateInput } from '../types';

export class ManualPaymentRepository {
  /**
   * Find the manual payment row for a cancellation request, if any.
   * Pass client for use inside withTransaction.
   */
  async findByCancellationRequestId(
    cancellationRequestId: number,
    client: PoolClient
  ): Promise<ManualPaymentRow | null> {
    const { rows } = await client.query(
      `SELECT * FROM manual_payments WHERE cancellation_request_id = $1 LIMIT 1`,
      [cancellationRequestId]
    );
    return (rows as unknown as ManualPaymentRow[])[0] || null;
  }

  /**
   * Insert a new manual payment row. MUST be called inside a transaction —
   * the UNIQUE INDEX on (cancellation_request_id) will reject a duplicate
   * INSERT with a unique violation, which by design surfaces concurrent
   * payment attempts as a clean ERROR that aborts the transaction.
   */
  async create(
    input: ManualPaymentCreateInput,
    client: PoolClient
  ): Promise<ManualPaymentRow> {
    const { rows } = await client.query(
      `INSERT INTO manual_payments (
         cancellation_request_id,
         customer_upi_id, amount_paise,
         transaction_ref_id, payment_date,
         paid_at,
         created_by_admin_id
       ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       RETURNING *`,
      [
        input.cancellation_request_id,
        input.customer_upi_id,
        input.amount_paise,
        input.transaction_ref_id,
        input.payment_date,
        input.created_by_admin_id,
      ]
    );
    return (rows as unknown as ManualPaymentRow[])[0];
  }
}

export const manualPaymentRepository = new ManualPaymentRepository();
