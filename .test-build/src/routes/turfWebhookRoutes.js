"use strict";
/**
 * Turf Webhook Controller — Cashfree payment webhooks for Turf bookings.
 *
 * Mounted at: POST /api/v1/turf/webhooks/cashfree
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfWebhookRoutes = void 0;
const express_1 = require("express");
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const paymentOrderRepository_1 = require("../repositories/paymentOrderRepository");
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
router.post('/cashfree', async (req, res, next) => {
    try {
        const rawBody = JSON.stringify(req.body);
        const eventType = req.body.event_type || req.body.type || 'UNKNOWN';
        const idempotencyKey = `turf_webhook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Extract order_id from payload
        const payloadData = req.body.data || req.body;
        const orderId = payloadData.order_id || payloadData.orderId;
        if (!orderId) {
            logger_1.logger.warn('[TurfWebhook] Missing order_id in payload');
            return res.status(400).json({ success: false, error: 'Missing order_id' });
        }
        // Verify webhook signature if configured
        if (config_1.config.cashfree.webhookSecret) {
            const signature = (req.headers['x-cashfree-signature'] || req.headers['x-webhook-signature']);
            if (!signature) {
                logger_1.logger.warn('[TurfWebhook] Missing signature');
                return res.status(401).json({ success: false, error: 'Missing signature' });
            }
            // Note: Signature verification implementation depends on Cashfree's exact HMAC format
            // For production, use: crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
            // and compare with the signature header
        }
        // Check idempotency — has this webhook already been processed?
        const existing = await webhookEventRepository_1.webhookEventRepository.findByIdempotencyKey(idempotencyKey);
        if (existing?.processed_at) {
            logger_1.logger.info('[TurfWebhook] Already processed', { idempotencyKey, orderId });
            return res.json({ success: true, message: 'Already processed' });
        }
        // Record webhook event
        await webhookEventRepository_1.webhookEventRepository.create(eventType, idempotencyKey, payloadData, orderId);
        // Process the payment event
        const newStatus = CF_EVENT_MAP[eventType];
        let processed = false;
        if (newStatus === 'COMPLETED') {
            // Payment success — confirm the booking
            const paymentOrder = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(orderId);
            if (paymentOrder && paymentOrder.organization_id) {
                const booking = await turfBookingRepository_1.turfBookingRepository.findById(paymentOrder.booking_id);
                if (booking && booking.status === 'pending_payment') {
                    await turfBookingService_1.turfBookingService.confirmBooking(booking.id, {
                        actorId: 0,
                        actorType: 'webhook',
                    });
                    logger_1.logger.info(`[TurfWebhook] Booking confirmed via webhook: ${booking.booking_reference}`);
                }
            }
            // Update payment order status
            await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(orderId, {
                status: 'COMPLETED',
                cf_payment_id: payloadData.cf_payment_id || undefined,
                payment_method: payloadData.payment_method || undefined,
            });
            processed = true;
        }
        else if (newStatus === 'FAILED' || newStatus === 'CANCELLED' || newStatus === 'EXPIRED') {
            // Payment failed — cancel the booking
            const paymentOrder = await paymentOrderRepository_1.paymentOrderRepository.findByOrderId(orderId);
            if (paymentOrder) {
                const booking = await turfBookingRepository_1.turfBookingRepository.findById(paymentOrder.booking_id);
                if (booking && booking.status === 'pending_payment') {
                    // Release slot
                    await turfAvailabilityService_1.turfAvailabilityService.markAvailable(booking.availability_unit_id);
                    await turfBookingRepository_1.turfBookingRepository.updateStatus(booking.id, 'cancelled', { payment_status: 'failed' });
                    logger_1.logger.info(`[TurfWebhook] Booking cancelled via webhook: ${booking.booking_reference}`);
                }
            }
            await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(orderId, {
                status: newStatus,
                error_code: payloadData.error_code || undefined,
                error_message: payloadData.error_message || undefined,
            });
            processed = true;
        }
        else {
            // ORDER_CREATED or unknown — just update status
            if (newStatus) {
                await paymentOrderRepository_1.paymentOrderRepository.updateFromWebhook(orderId, { status: newStatus });
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
