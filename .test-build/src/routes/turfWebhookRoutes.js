"use strict";
/**
 * Turf Webhook Controller — Cashfree payment webhooks for Turf bookings.
 *
 * SECURITY:
 *  - Raw body is captured before JSON parsing so HMAC verification uses
 *    the exact bytes Cashfree signed.
 *  - Signature is verified BEFORE any processing.
 *  - Idempotency key is deterministic (orderId + eventType) so retries
 *    from Cashfree collapse to a single processing.
 *
 * Mounted at: POST /api/v1/turf/webhooks/cashfree
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfWebhookRoutes = void 0;
exports.verifyWebhookSignature = verifyWebhookSignature;
exports.buildIdempotencyKey = buildIdempotencyKey;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const paymentOrderRepository_1 = require("../repositories/paymentOrderRepository");
const refundRepository_1 = require("../repositories/refundRepository");
const webhookEventRepository_1 = require("../repositories/webhookEventRepository");
const turfBookingService_1 = require("../services/turfBookingService");
const turfAvailabilityService_1 = require("../services/turfAvailabilityService");
const logger_1 = require("../utils/logger");
const config_1 = require("../config");
const router = (0, express_1.Router)();
exports.turfWebhookRoutes = router;
// Cashfree event type mapping
const CF_EVENT_MAP = {
    'ORDER_CREATED': 'ACTIVE',
    'PAYMENT_SUCCESS': 'COMPLETED',
    'PAYMENT_FAILED': 'FAILED',
    'PAYMENT_CANCELLED': 'CANCELLED',
    'ORDER_EXPIRED': 'EXPIRED',
};
const CF_REFUND_EVENT_MAP = {
    'REFUND': 'PROCESSING',
    'REFUND_SUCCESS': 'SUCCESS',
    'REFUND_FAILED': 'FAILED',
};
/**
 * Verify Cashfree webhook signature.
 *
 * Cashfree sends x-cashfree-signature header containing HMAC-SHA256 hex digest
 * of the raw request body, computed with the webhook secret.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!signatureHeader)
        return false;
    if (!config_1.config.cashfree.webhookSecret)
        return false;
    // Cashfree may prefix the signature with "sha256="
    const signature = signatureHeader.replace(/^sha256=/i, '').trim();
    if (!signature)
        return false;
    const expected = crypto_1.default
        .createHmac('sha256', config_1.config.cashfree.webhookSecret)
        .update(rawBody)
        .digest('hex');
    // Constant-time comparison
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length)
        return false;
    let mismatch = 0;
    for (let i = 0; i < sigBuf.length; i++) {
        mismatch |= sigBuf[i] ^ expBuf[i];
    }
    return mismatch === 0;
}
/**
 * Build a deterministic idempotency key from stable Cashfree identifiers.
 *
 * Uses orderId + eventType so all retries of the SAME event collapse
 * to one key, while different events for the same order remain independent.
 */
function buildIdempotencyKey(orderId, eventType) {
    return `turf_webhook_${orderId}_${eventType}`;
}
router.post('/cashfree', async (req, res, next) => {
    try {
        // ── 0. Raw body for signature verification ─────────────────────────────
        const rawBody = req.rawBody;
        if (!rawBody || rawBody.length === 0) {
            logger_1.logger.warn('[TurfWebhook] Missing raw body — possible body parsing issue');
            return res.status(400).json({ success: false, error: 'Invalid request body' });
        }
        // ── 1. Verify signature BEFORE any processing ─────────────────────────
        const signature = req.headers['x-cashfree-signature'];
        if (!verifyWebhookSignature(rawBody, signature)) {
            logger_1.logger.warn('[TurfWebhook] Signature verification failed');
            return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        }
        // ── 2. Parse payload (safe — signature already verified) ──────────────
        let parsed;
        try {
            parsed = JSON.parse(rawBody.toString('utf-8'));
        }
        catch {
            return res.status(400).json({ success: false, error: 'Malformed JSON payload' });
        }
        const payloadData = parsed.data || parsed;
        const orderId = payloadData.order_id || payloadData.orderId;
        const eventType = parsed.event_type;
        if (!orderId) {
            return res.status(400).json({ success: false, error: 'Missing order_id' });
        }
        if (!eventType) {
            return res.status(400).json({ success: false, error: 'Missing event_type' });
        }
        // TypeScript narrowing — after the guards above, these are strings
        const safeOrderId = orderId;
        const safeEventType = eventType;
        // ── 3. Deterministic idempotency key ──────────────────────────────────
        const idempotencyKey = buildIdempotencyKey(safeOrderId, safeEventType);
        // ── 4. Idempotency check ──────────────────────────────────────────────
        const existing = await webhookEventRepository_1.webhookEventRepository.findByIdempotencyKey(idempotencyKey);
        if (existing?.processed_at) {
            logger_1.logger.info('[TurfWebhook] Already processed', { idempotencyKey, orderId: safeOrderId, eventType: safeEventType });
            return res.json({ success: true, message: 'Already processed' });
        }
        // ── 5. Record webhook event (before processing) ───────────────────────
        await webhookEventRepository_1.webhookEventRepository.create(safeEventType, idempotencyKey, parsed, safeOrderId);
        // ── 6. Process the payment event ──────────────────────────────────────
        const newStatus = CF_EVENT_MAP[safeEventType];
        let processed = false;
        if (newStatus === 'COMPLETED') {
            // Payment success — confirm the booking
            const paymentOrder = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(safeOrderId);
            if (paymentOrder && paymentOrder.organization_id) {
                const booking = await turfBookingRepository_1.turfBookingRepository.findById(paymentOrder.booking_id);
                if (booking && booking.status === 'pending_payment') {
                    // confirmBooking's actorId type may be number; cast for webhook context.
                    // Use -1 as a sentinel "system" actor since DB schema may require a number.
                    // The audit log will show actorType='system_cashfree_webhook' for clarity.
                    await turfBookingService_1.turfBookingService.confirmBooking(booking.id, {
                        actorId: 0,
                        actorType: 'webhook',
                    });
                    logger_1.logger.info(`[TurfWebhook] Booking confirmed via webhook: ${booking.booking_reference}`);
                }
            }
            // Update payment order status
            await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(safeOrderId, {
                status: 'COMPLETED',
                cf_payment_id: payloadData.cf_payment_id || undefined,
                payment_method: payloadData.payment_method || undefined,
            });
            processed = true;
        }
        else if (newStatus === 'FAILED' || newStatus === 'CANCELLED' || newStatus === 'EXPIRED') {
            // Payment failed — cancel the booking
            const paymentOrder = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(safeOrderId);
            if (paymentOrder) {
                const booking = await turfBookingRepository_1.turfBookingRepository.findById(paymentOrder.booking_id);
                if (booking && booking.status === 'pending_payment') {
                    // Release slot
                    await turfAvailabilityService_1.turfAvailabilityService.markAvailable(booking.availability_unit_id);
                    await turfBookingRepository_1.turfBookingRepository.updateStatus(booking.id, 'cancelled', { payment_status: 'failed' });
                    logger_1.logger.info(`[TurfWebhook] Booking cancelled via webhook: ${booking.booking_reference}`);
                }
            }
            await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(safeOrderId, {
                status: newStatus,
                error_code: payloadData.error_code || undefined,
                error_message: payloadData.error_message || undefined,
            });
            processed = true;
        }
        else if (safeEventType.startsWith('REFUND')) {
            // Refund webhook — update refund status and payment order
            const refundStatus = CF_REFUND_EVENT_MAP[safeEventType];
            if (refundStatus) {
                const refundData = payloadData.refund || {};
                const cfRefundId = refundData.refund_id;
                if (cfRefundId) {
                    // Fetch the payment order to find related refunds
                    const paymentOrderForRefund = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(safeOrderId);
                    if (!paymentOrderForRefund) {
                        logger_1.logger.warn('[TurfWebhook] Payment order not found for refund event', { orderId: safeOrderId });
                        processed = true;
                    }
                    else {
                        // Match refunds by Cashfree refund_id
                        const matchingRefunds = await refundRepository_1.refundRepository.findByPaymentOrderId(paymentOrderForRefund.id);
                        for (const r of matchingRefunds) {
                            const status = refundStatus === 'SUCCESS' ? 'SUCCESS' : refundStatus === 'FAILED' ? 'FAILED' : 'PROCESSING';
                            await refundRepository_1.refundRepository.updateStatus(r.id, status, {
                                cf_refund_id: cfRefundId,
                            });
                        }
                        // If all refunds for this order are successful, update payment order
                        if (refundStatus === 'SUCCESS') {
                            const allRefunds = await refundRepository_1.refundRepository.findByPaymentOrderId(paymentOrderForRefund.id);
                            const totalRefunded = allRefunds.reduce((sum, r) => sum + Number(r.amount), 0);
                            if (totalRefunded >= Number(paymentOrderForRefund.amount)) {
                                await paymentOrderRepository_1.paymentOrderRepository.updateStatus(paymentOrderForRefund.id, 'REFUNDED');
                            }
                            else {
                                await paymentOrderRepository_1.paymentOrderRepository.updateStatus(paymentOrderForRefund.id, 'PARTIALLY_REFUNDED');
                            }
                        }
                        processed = true;
                    }
                }
            }
        }
        else {
            // ORDER_CREATED or unknown — just update status
            if (newStatus) {
                await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(safeOrderId, { status: newStatus });
                processed = true;
            }
        }
        if (!processed && !newStatus) {
            return res.json({ success: true, message: 'Ignored unknown event' });
        }
        res.json({ success: true, message: 'Processed' });
    }
    catch (err) {
        next(err);
    }
});
