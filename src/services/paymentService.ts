/**
 * Universal Payment Service — provider-agnostic orchestration layer.
 *
 * Responsibilities:
 *   1. Create payment orders (with idempotency)
 *   2. Verify payments (after callback or webhook)
 *   3. Handle payment provider webhook notifications
 *   4. Process refunds
 *   5. Poll stale orders for reconciliation
 *
 * This service NEVER knows which payment provider it's talking to —
 * that's the gateway's job. It delegates all provider-specific operations
 * to an IPaymentGateway implementation.
 *
 * Domain services (event, turf, movie) should use this service, never
 * the gateway directly.
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { withTransaction, getPool } from '../db/pool';
import { withTimeout } from '../utils/withTimeout';
import { config } from '../config';
import type { PaymentOrderRow, PaymentOrderStatus, PaymentOrderCreateInput, RefundRow, RefundCreateInput } from '../types';

import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { refundRepository } from '../repositories/refundRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { eventRepository } from '../repositories/eventRepository';
import type { IPaymentGateway, PollPaymentResult } from './paymentGateway';
import { PricingEngine } from './pricingEngine';

const GATEWAY_TIMEOUT_MS = config.paymentProvider.gatewayTimeoutMs;

// ── Service ───────────────────────────────────────────────────────────────────

export class PaymentService {
  constructor(private readonly gateway: IPaymentGateway) {}

  /**
   * Create a payment order with idempotency check.
   * Returns the payment session ID for the frontend to open the payment modal.
   */
  async createOrder(input: PaymentOrderCreateInput & {
    customerEmail: string;
    customerPhone: string;
    customerName: string;
    orderId: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ order: PaymentOrderRow; paymentSessionId: string }> {
    // 1) Idempotency: if we already processed this key, return the existing order
    if (input.idempotency_key) {
      const existing = await paymentOrderRepository.findByIdempotencyKey(input.idempotency_key);
      if (existing) {
        logger.info('Idempotent createOrder returning existing', { orderId: existing.order_id });
        return { order: existing, paymentSessionId: existing.provider_session_id || '' };
      }
    }

    // 2) Resolve organization — either from event (Event domain) or directly (Turf/Movie domain)
    let organizationId: number | null | undefined = input.organization_id;
    if (input.event_id != null) {
      const event = await eventRepository.getEventById(input.event_id);
      if (!event) throw new AppError('Event not found', 404);
      organizationId = event.organization_id ?? organizationId;
    }
    if (!organizationId) throw new AppError('Organization not found', 400);

    // 3) Create the gateway order (with timeout to prevent hung connections from starving the pool)
    const gatewayResult = await withTimeout(
      this.gateway.createOrder({
        bookingId: input.booking_id,
        amount: input.amount,
        currency: input.currency || 'INR',
        orderId: input.orderId,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        metadata: { organization_id: organizationId, event_id: input.event_id, ...input.metadata },
      }),
      GATEWAY_TIMEOUT_MS,
      'paymentGateway.createOrder',
    );

    // 4) Persist to DB — include movie_id so booking_type resolves correctly
    const order = await paymentOrderRepository.create({
      booking_id: input.booking_id,
      organization_id: organizationId,
      event_id: input.event_id ?? null,
      movie_id: (input as any).movie_id ?? null,
      amount: input.amount,
      currency: input.currency || 'INR',
      order_id: input.orderId,
      idempotency_key: input.idempotency_key,
      payment_gateway: this.gateway.name as PaymentOrderRow['payment_gateway'],
      financial_snapshot: (input as any).financial_snapshot ?? null,
    });

    // 5) Update with gateway data (provider-agnostic field names)
    await paymentOrderRepository.updateFromWebhook(order.order_id, {
      status: 'ACTIVE',
      provider_session_id: gatewayResult.gatewayResponse.payment_session_id,
      provider_order_token: '',
    });

    const updated = await paymentOrderRepository.findByOrderId(order.order_id)!;
    if (!updated) throw new AppError('Failed to persist payment order', 500);

    logger.info('Payment order created', { orderId: order.order_id, bookingId: input.booking_id });
    return { order: updated, paymentSessionId: gatewayResult.gatewayResponse.payment_session_id };
  }

  /**
   * Verify a payment — called after the user returns from the payment page
   * or when processing a webhook. Server-side verification is the source of truth.
   *
   * Concurrency safety:
   *   - Wraps the gateway call + DB update in a transaction with
   *     SELECT ... FOR UPDATE on the payment_orders row.
   *   - This serializes concurrent verifyPayment + webhook delivery
   *     for the same order. Whichever path gets the lock first commits
   *     its terminal status; the other sees the new state when it
   *     acquires the lock and short-circuits.
   *   - updateFromWebhook has a terminal-state guard (NOT IN COMPLETED,
   *     REFUNDED, PARTIALLY_REFUNDED) so a stale webhook cannot
   *     downgrade a COMPLETED order.
   */
  async verifyPayment(orderId: string): Promise<PaymentOrderRow> {
    return withTransaction(async (client) => {
      // 1. Lock the row — concurrent verifyPayment + webhook serialise here
      const lockResult = await client.query(
        `SELECT * FROM payment_orders WHERE order_id = $1 FOR UPDATE`,
        [orderId]
      );
      const lockedOrder = lockResult.rows[0] as PaymentOrderRow | undefined;
      if (!lockedOrder) throw new AppError('Payment order not found', 404);

      // 2. Short-circuit if a concurrent path already produced a terminal result
      const TERMINAL = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;
      if ((TERMINAL as readonly string[]).includes(lockedOrder.status)) {
        logger.info('[Payment] verifyPayment short-circuit — order is already terminal', {
          orderId,
          status: lockedOrder.status,
        });
        return lockedOrder;
      }

      // 3. Call the gateway (with timeout — hung gateway would starve the DB connection pool)
      const verifyResult = await withTimeout(
        this.gateway.verifyPayment(orderId, {}),
        GATEWAY_TIMEOUT_MS,
        'paymentGateway.verifyPayment',
      );

      // 4. Apply guarded update — terminal guard prevents downgrade
      const updateResult = await client.query(
        `UPDATE payment_orders SET status = $1, provider_payment_id = COALESCE($2, provider_payment_id),
                payment_method = COALESCE($3, payment_method),
                error_code = COALESCE($4, error_code), error_message = COALESCE($5, error_message),
                verified_at = NOW(), verified_by = 'api_poll', retry_count = retry_count + 1,
                updated_at = NOW()
         WHERE order_id = $6 AND status NOT IN ($7, $8, $9)
         RETURNING *`,
        [
          verifyResult.status,
          verifyResult.paymentId || null,
          verifyResult.paymentMethod || null,
          verifyResult.errorCode || null,
          verifyResult.errorMessage || null,
          orderId,
          'COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED',
        ]
      );

      const updated = (updateResult.rows as unknown as PaymentOrderRow[])[0];
      if (!updated) {
        // Re-read current state — likely a concurrent webhook finalised
        // the order while we were calling the gateway
        const current = await client.query(
          `SELECT * FROM payment_orders WHERE order_id = $1`, [orderId]
        );
        const cur = (current.rows[0] as unknown as PaymentOrderRow);
        if (cur) {
          logger.info('[Payment] verifyPayment saw terminal state after gateway call — keeping existing', {
            orderId,
            currentStatus: cur.status,
            verifiedStatus: verifyResult.status,
          });
          return cur;
        }
        throw new AppError('Failed to update payment order', 500);
      }

      if (verifyResult.status === 'COMPLETED') {
        logger.info('Payment verified successfully', { orderId, paymentId: verifyResult.paymentId });
      } else if (verifyResult.status === 'FAILED' || verifyResult.status === 'CANCELLED' || verifyResult.status === 'EXPIRED') {
        logger.warn('Payment failed', { orderId, status: verifyResult.status });
      }

      return updated;
    });
  }

  /**
   * Handle an incoming payment provider webhook.
   * Idempotent — uses the webhook_events idempotency key to avoid double-processing.
   */
  async handleWebhook(
    idempotencyKey: string,
    eventType: string,
    rawPayload: Record<string, unknown>,
  ): Promise<PaymentOrderRow> {
    // 1) Check if already processed
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('Webhook already processed', { idempotencyKey });
      const order = await paymentOrderRepository.findByOrderId(existing.related_order_id || '');
      if (order) return order;
      throw new AppError('Webhook processed but order not found', 404);
    }

    const orderId = (rawPayload.data as Record<string, unknown>)?.order_id as string;
    if (!orderId) throw new AppError('Missing order_id in webhook payload', 400);

    // 2) Record webhook event
    const webhookEvent = await webhookEventRepository.create(eventType, idempotencyKey, rawPayload, orderId);

    // 3) Verify signature if available
    const signature = rawPayload['signature'] as string | undefined;
    if (signature && !this.gateway.verifyWebhookSignature(JSON.stringify(rawPayload), signature)) {
      logger.warn('Webhook signature verification failed', { orderId, eventType });
      throw new AppError('Invalid webhook signature', 401);
    }

    // 4) Process the payment event
    try {
      const order = await this.processWebhookEvent(orderId, eventType, rawPayload);
      await webhookEventRepository.markProcessed(webhookEvent.id);
      logger.info('Webhook processed successfully', { orderId, eventType });
      return order;
    } catch (err) {
      logger.error('Webhook processing failed', { orderId, eventType, error: (err as Error).message });
      await webhookEventRepository.markFailed(webhookEvent.id, (err as Error).message);
      throw err;
    }
  }

  /**
   * Process a refund request.
   *
   * Concurrency safety:
   *   - The payment order row is locked (SELECT ... FOR UPDATE) at the start
   *     of the transaction. This serializes concurrent refund requests for the
   *     same order and prevents the TOCTOU race.
   *   - The remaining-refundable amount is computed and validated BEFORE calling
   *     the gateway, so the DB-side check is authoritative.
   */
  async processRefund(input: RefundCreateInput, actor: { adminId?: number; userId?: number }): Promise<RefundRow> {
    // NO CUSTOMER REFUND POLICY — only admin-initiated settlements allowed
    if (input.refund_type === 'customer_initiated') {
      throw new AppError('Customer refunds are not permitted. Use settlement workflow for organisation payouts.', 403);
    }
    return withTransaction(async (client) => {
      // 1. Lock the payment order row — serializes concurrent refunds
      const orderResult = await client.query(
        'SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE',
        [input.payment_order_id]
      );
      const order = orderResult.rows[0];
      if (!order) throw new AppError('Payment order not found', 404);

      // 2. Validate order status
      if (order.status !== 'COMPLETED' && order.status !== 'PARTIALLY_REFUNDED') {
        throw new AppError(`Cannot refund order in status: ${order.status}`, 409);
      }

      // 3. Compute total already refunded within the same locked transaction
      const refundsResult = await client.query(
        `SELECT amount FROM refunds WHERE payment_order_id = $1 AND status = $2`,
        [input.payment_order_id, 'SUCCESS']
      );
      const totalRefunded = refundsResult.rows.reduce((sum, r) => sum + Number(r.amount), 0);
      const remainingRefundable = Number(order.amount) - totalRefunded;

      if (Number(input.amount) > remainingRefundable) {
        throw new AppError(
          `Refund amount ${input.amount} exceeds remaining refundable amount ${remainingRefundable}`,
          400
        );
      }

      // 4. Call payment gateway (with timeout — hung connection would hold DB lock indefinitely)
      const result = await withTimeout(
        this.gateway.createRefund({
          orderId: order.order_id,
          amount: Number(input.amount),
          reason: input.reason ?? undefined,
        }),
        GATEWAY_TIMEOUT_MS,
        'paymentGateway.createRefund',
      );

      // 5. Persist refund record (uses the transaction client)
      const refund = await refundRepository.create({
        payment_order_id: input.payment_order_id,
        booking_id: order.booking_id,
        amount: Number(input.amount),
        reason: input.reason ?? undefined,
        refund_type: input.refund_type ?? 'admin_initiated',
      }, client);

      // 6. Update payment order status based on new total (uses the transaction client)
      const newTotalRefunded = totalRefunded + Number(input.amount);
      if (newTotalRefunded >= Number(order.amount)) {
        await paymentOrderRepository.updateStatus(order.id, 'REFUNDED', {}, client);
      } else {
        await paymentOrderRepository.updateStatus(order.id, 'PARTIALLY_REFUNDED', {}, client);
      }

      logger.info('Refund processed', { refundId: refund.id, orderId: order.order_id, amount: input.amount });
      return refund;
    });
  }

  /**
   * Reconcile stale payment orders by polling the gateway.
   */
  async reconcileStaleOrders(olderThanMinutes: number = 30): Promise<PaymentOrderRow[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    const { rows: staleRows } = await getPool()
      .query(`SELECT * FROM payment_orders WHERE status IN ('CREATED','ACTIVE') AND created_at < $1 ORDER BY created_at ASC LIMIT 100`, [cutoff]);
    const staleOrders = staleRows as unknown as PaymentOrderRow[];

    const reconciled: PaymentOrderRow[] = [];
    for (const order of staleOrders) {
      try {
        const pollResult = await withTimeout(
          this.gateway.pollPaymentStatus(order.order_id),
          GATEWAY_TIMEOUT_MS,
          'paymentGateway.pollPaymentStatus',
        );
        if (pollResult.status !== 'ACTIVE') {
          const updated = await paymentOrderRepository.updateFromWebhook(order.order_id, {
            status: pollResult.status,
            error_code: pollResult.errorCode || undefined,
          });
          if (updated) reconciled.push(updated);
        }
      } catch (err) {
        // Log but continue — individual order failures shouldn't block the batch
        logger.warn('[Payment] reconcileStaleOrders poll failed', {
          orderId: order.order_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reconciled;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async processWebhookEvent(
    orderId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<PaymentOrderRow> {
    const order = await paymentOrderRepository.findByOrderId(orderId);
    if (!order) throw new AppError('Order not found for webhook', 404);

    // Provider event type mapping — each provider maps its event types to our statuses
    const statusMap: Record<string, PaymentOrderStatus> = {
      'ORDER_CREATED': 'ACTIVE',
      'PAYMENT_SUCCESS': 'COMPLETED',
      'PAYMENT_FAILED': 'FAILED',
      'PAYMENT_CANCELLED': 'CANCELLED',
      'ORDER_EXPIRED': 'EXPIRED',
    };

    const newStatus = statusMap[eventType];
    if (newStatus && newStatus !== order.status) {
      const paymentData = (payload.data as Record<string, unknown>) || {};
      await paymentOrderRepository.updateFromWebhook(orderId, {
        status: newStatus,
        provider_payment_id: (paymentData.provider_payment_id as string) || undefined,
        payment_method: (paymentData.payment_method as string) || undefined,
        error_code: (payload as { error_details?: { error_code: string } }).error_details?.error_code,
        error_message: (payload as { error_details?: { error_message: string } }).error_details?.error_message,
      });
    }

    const updated = await paymentOrderRepository.findByOrderId(orderId);
    if (!updated) throw new AppError('Order not found after webhook update', 404);
    return updated;
  }

  /**
   * Verify that the payment amount matches the server-calculated expected amount.
   * ALWAYS call this before confirming a booking. Never trust client-provided amounts.
   */
  verifyPaymentAmount(expectedPaise: number, paidPaise: number): void {
    if (expectedPaise !== paidPaise) {
      throw new AppError(
        `Payment amount mismatch: expected ${expectedPaise} paise (₹${(expectedPaise / 100).toFixed(2)}), ` +
        `received ${paidPaise} paise (₹${(paidPaise / 100).toFixed(2)})`, 402);
    }
  }
}

/**
 * Factory — creates a PaymentService wired to any IPaymentGateway implementation.
 */
export function createPaymentService(gateway: IPaymentGateway): PaymentService {
  return new PaymentService(gateway);
}

// ── Module-level singleton ────────────────────────────────────────────────────
// Depends on config being loaded (it always is at this point since server.ts
// imports config first). Gateway is injected lazily on first use.

let _singleton: PaymentService | null = null;

export function getPaymentService(gateway?: IPaymentGateway): PaymentService {
  if (!_singleton) {
    if (!gateway) {
      throw new AppError('PaymentService not initialized — pass a gateway on first call', 500);
    }
    _singleton = createPaymentService(gateway);
  }
  return _singleton;
}
