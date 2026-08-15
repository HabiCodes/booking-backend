"use strict";
/**
 * Payment Service — orchestration layer for Cashfree payment flows.
 *
 * Responsibilities:
 *   1. Create payment orders (with idempotency)
 *   2. Verify payments (after callback or webhook)
 *   3. Handle Cashfree webhook notifications
 *   4. Process refunds
 *   5. Poll stale orders for reconciliation
 *
 * NEVER expose Cashfree credentials to the client.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentService = void 0;
exports.createPaymentService = createPaymentService;
exports.getPaymentService = getPaymentService;
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
const paymentOrderRepository_1 = require("../repositories/paymentOrderRepository");
const refundRepository_1 = require("../repositories/refundRepository");
const webhookEventRepository_1 = require("../repositories/webhookEventRepository");
const eventRepository_1 = require("../repositories/eventRepository");
const cashfreeService_1 = require("./cashfreeService");
// ── Service ───────────────────────────────────────────────────────────────────
class PaymentService {
    constructor(gateway) {
        this.gateway = gateway;
    }
    /**
     * Create a payment order with idempotency check.
     * Returns the payment session ID for the frontend to open Cashfree's payment modal.
     */
    async createOrder(input) {
        // 1) Idempotency: if we already processed this key, return the existing order
        if (input.idempotency_key) {
            const existing = await paymentOrderRepository_1.paymentOrderRepository.findByIdempotencyKey(input.idempotency_key);
            if (existing) {
                logger_1.logger.info('Idempotent createOrder returning existing', { orderId: existing.order_id });
                return { order: existing, paymentSessionId: existing.cf_payment_session_id || '' };
            }
        }
        // 2) Resolve organization — either from event (Event domain) or directly (Turf domain)
        let organizationId = input.organization_id;
        if (input.event_id != null) {
            const event = await eventRepository_1.eventRepository.getEventById(input.event_id);
            if (!event)
                throw new errorHandler_1.AppError('Event not found', 404);
            organizationId = event.organization_id ?? organizationId;
        }
        if (!organizationId)
            throw new errorHandler_1.AppError('Organization not found', 400);
        // 3) Create the gateway order
        const gatewayResult = await this.gateway.createOrder({
            bookingId: input.booking_id,
            amount: input.amount,
            currency: input.currency || 'INR',
            orderId: input.orderId,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone,
            customerName: input.customerName,
            metadata: { organization_id: organizationId, event_id: input.event_id, ...input.metadata },
        });
        // 4) Persist to DB
        const order = await paymentOrderRepository_1.paymentOrderRepository.create({
            booking_id: input.booking_id,
            organization_id: organizationId,
            event_id: input.event_id ?? null,
            amount: input.amount,
            currency: input.currency || 'INR',
            order_id: input.orderId,
            idempotency_key: input.idempotency_key,
        });
        // 5) Update with gateway data
        await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(order.order_id, {
            status: 'ACTIVE',
            cf_payment_session_id: gatewayResult.gatewayResponse.payment_session_id,
            cf_order_token: '',
        });
        const updated = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(order.order_id);
        if (!updated)
            throw new errorHandler_1.AppError('Failed to persist payment order', 500);
        logger_1.logger.info('Payment order created', { orderId: order.order_id, bookingId: input.booking_id });
        return { order: updated, paymentSessionId: gatewayResult.gatewayResponse.payment_session_id };
    }
    /**
     * Verify a payment — called after the user returns from the payment page
     * or when processing a webhook. Server-side verification is the source of truth.
     */
    async verifyPayment(orderId) {
        const order = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(orderId);
        if (!order)
            throw new errorHandler_1.AppError('Payment order not found', 404);
        const verifyResult = await this.gateway.verifyPayment(orderId, {});
        const updated = await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(orderId, {
            status: verifyResult.status,
            cf_payment_id: verifyResult.paymentId || undefined,
            payment_method: verifyResult.paymentMethod || undefined,
            error_code: verifyResult.errorCode || undefined,
            error_message: verifyResult.errorMessage || undefined,
        });
        if (!updated)
            throw new errorHandler_1.AppError('Failed to update payment order', 500);
        if (verifyResult.status === 'COMPLETED') {
            logger_1.logger.info('Payment verified successfully', { orderId, paymentId: verifyResult.paymentId });
        }
        else if (verifyResult.status === 'FAILED' || verifyResult.status === 'CANCELLED' || verifyResult.status === 'EXPIRED') {
            logger_1.logger.warn('Payment failed', { orderId, status: verifyResult.status });
        }
        return updated;
    }
    /**
     * Handle an incoming Cashfree webhook.
     * Idempotent — uses the webhook_events idempotency key to avoid double-processing.
     */
    async handleWebhook(idempotencyKey, eventType, rawPayload) {
        // 1) Check if already processed
        const existing = await webhookEventRepository_1.webhookEventRepository.findByIdempotencyKey(idempotencyKey);
        if (existing?.processed_at) {
            logger_1.logger.info('Webhook already processed', { idempotencyKey });
            const order = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(existing.related_order_id || '');
            if (order)
                return order;
            throw new errorHandler_1.AppError('Webhook processed but order not found', 404);
        }
        const orderId = rawPayload.data?.order_id;
        if (!orderId)
            throw new errorHandler_1.AppError('Missing order_id in webhook payload', 400);
        // 2) Record webhook event
        await webhookEventRepository_1.webhookEventRepository.create(eventType, idempotencyKey, rawPayload, orderId);
        // 3) Verify signature if available
        const signature = rawPayload['signature'];
        if (signature && !this.gateway.verifyWebhookSignature(JSON.stringify(rawPayload), signature)) {
            logger_1.logger.warn('Webhook signature verification failed', { orderId, eventType });
            throw new errorHandler_1.AppError('Invalid webhook signature', 401);
        }
        // 4) Process the payment event
        try {
            const order = await this.processWebhookEvent(orderId, eventType, rawPayload);
            await webhookEventRepository_1.webhookEventRepository.markProcessed(existing?.id || 0);
            logger_1.logger.info('Webhook processed successfully', { orderId, eventType });
            return order;
        }
        catch (err) {
            logger_1.logger.error('Webhook processing failed', { orderId, eventType, error: err.message });
            await webhookEventRepository_1.webhookEventRepository.markFailed(existing?.id || 0, err.message);
            throw err;
        }
    }
    /**
     * Process a refund request.
     *
     * Concurrency safety:
     *   - The payment order row is locked (SELECT ... FOR UPDATE) at the start
     *     of the transaction. This serializes concurrent refund requests for the
     *     same order and prevents the TOCTOU race where two requests could both
     *     read totalRefunded = 0 before either commits.
     *   - The remaining-refundable amount is computed and validated BEFORE calling
     *     the Cashfree gateway, so the DB-side check is authoritative.
     */
    async processRefund(input, actor) {
        return (0, pool_1.withTransaction)(async (client) => {
            // 1. Lock the payment order row — serializes concurrent refunds
            const orderResult = await client.query('SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE', [input.payment_order_id]);
            const order = orderResult.rows[0];
            if (!order)
                throw new errorHandler_1.AppError('Payment order not found', 404);
            // 2. Validate order status
            if (order.status !== 'COMPLETED' && order.status !== 'PARTIALLY_REFUNDED') {
                throw new errorHandler_1.AppError(`Cannot refund order in status: ${order.status}`, 409);
            }
            // 3. Compute total already refunded within the same locked transaction
            const refundsResult = await client.query(`SELECT amount FROM refunds WHERE payment_order_id = $1 AND status = $2`, [input.payment_order_id, 'SUCCESS']);
            const totalRefunded = refundsResult.rows.reduce((sum, r) => sum + Number(r.amount), 0);
            const remainingRefundable = Number(order.amount) - totalRefunded;
            if (Number(input.amount) > remainingRefundable) {
                throw new errorHandler_1.AppError(`Refund amount ${input.amount} exceeds remaining refundable amount ${remainingRefundable}`, 400);
            }
            // 4. Call Cashfree gateway (outside the critical section is fine — the DB
            //    lock already prevents concurrent approval; if the gateway fails, the
            //    transaction rolls back and no state changes)
            const result = await this.gateway.createRefund({
                orderId: order.order_id,
                amount: Number(input.amount),
                reason: input.reason ?? undefined,
            });
            // 5. Persist refund record (uses the transaction client)
            const refund = await refundRepository_1.refundRepository.create({
                payment_order_id: input.payment_order_id,
                booking_id: order.booking_id,
                amount: Number(input.amount),
                reason: input.reason ?? undefined,
                refund_type: input.refund_type ?? 'customer_initiated',
            }, client);
            // 6. Update payment order status based on new total (uses the transaction client)
            const newTotalRefunded = totalRefunded + Number(input.amount);
            if (newTotalRefunded >= Number(order.amount)) {
                await paymentOrderRepository_1.paymentOrderRepository.updateStatus(order.id, 'REFUNDED', {}, client);
            }
            else {
                await paymentOrderRepository_1.paymentOrderRepository.updateStatus(order.id, 'PARTIALLY_REFUNDED', {}, client);
            }
            logger_1.logger.info('Refund processed', { refundId: refund.id, orderId: order.order_id, amount: input.amount });
            return refund;
        });
    }
    /**
     * Reconcile stale payment orders by polling the gateway.
     */
    async reconcileStaleOrders(olderThanMinutes = 30) {
        const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
        const staleOrders = (await paymentOrderRepository_1.paymentOrderRepository.findByOrganization(0, { pageSize: 100 }))
            .items.filter(o => ['CREATED', 'ACTIVE'].includes(o.status) && o.created_at < cutoff);
        const reconciled = [];
        for (const order of staleOrders) {
            try {
                const pollResult = await this.gateway.pollPaymentStatus(order.order_id);
                if (pollResult.status !== 'ACTIVE') {
                    const updated = await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(order.order_id, {
                        status: pollResult.status,
                        error_code: pollResult.errorCode || undefined,
                    });
                    if (updated)
                        reconciled.push(updated);
                }
            }
            catch {
                // Continue to next order
            }
        }
        return reconciled;
    }
    // ── Private ────────────────────────────────────────────────────────────────
    async processWebhookEvent(orderId, eventType, payload) {
        const order = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(orderId);
        if (!order)
            throw new errorHandler_1.AppError('Order not found for webhook', 404);
        // Map Cashfree event types to our status
        const statusMap = {
            'ORDER_CREATED': 'ACTIVE',
            'PAYMENT_SUCCESS': 'COMPLETED',
            'PAYMENT_FAILED': 'FAILED',
            'PAYMENT_CANCELLED': 'CANCELLED',
            'ORDER_EXPIRED': 'EXPIRED',
        };
        const newStatus = statusMap[eventType];
        if (newStatus && newStatus !== order.status) {
            const paymentData = payload.data || {};
            await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(orderId, {
                status: newStatus,
                cf_payment_id: paymentData.cf_payment_id || undefined,
                payment_method: paymentData.payment_method || undefined,
                error_code: payload.error_details?.error_code,
                error_message: payload.error_details?.error_message,
            });
        }
        const updated = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(orderId);
        if (!updated)
            throw new errorHandler_1.AppError('Order not found after webhook update', 404);
        return updated;
    }
}
exports.PaymentService = PaymentService;
/**
 * Factory — creates a PaymentService wired to a Cashfree gateway instance.
 */
function createPaymentService(config) {
    return new PaymentService(new cashfreeService_1.CashfreePaymentGateway(config));
}
let _paymentService = null;
function getPaymentService(config) {
    if (!_paymentService && config) {
        _paymentService = createPaymentService(config);
    }
    if (!_paymentService) {
        _paymentService = createPaymentService({
            appId: process.env.CASHFREE_APP_ID || '',
            secretKey: process.env.CASHFREE_SECRET_KEY || '',
            webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || '',
            returnUrl: process.env.CASHFREE_RETURN_URL || '',
            notifyUrl: process.env.CASHFREE_NOTIFY_URL || '',
        });
    }
    return _paymentService;
}
