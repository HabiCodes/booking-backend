/**
 * Movie Webhook Controller — Cashfree payment webhooks for Movie bookings.
 *
 * SECURITY:
 *  - Raw body is captured before JSON parsing so HMAC verification uses
 *    the exact bytes Cashfree signed.
 *  - Signature is verified BEFORE any processing.
 *  - Idempotency key is deterministic (orderId + eventType) so retries
 *    from Cashfree collapse to a single processing.
 *
 * Mounted at: POST /api/v1/movies/webhooks/cashfree
 */

import { Router } from 'express';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { movieBookingItemRepository } from '../repositories/movieBookingItemRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { movieBookingService } from '../services/movieBookingService';
import { showtimeRepository } from '../repositories/showtimeRepository';
import { logger } from '../utils/logger';
import { config } from '../config';

const router = Router();

// Cashfree event type mapping — same keys as turf for consistency
const CF_EVENT_MAP: Record<string, string> = {
  'ORDER_CREATED': 'ACTIVE',
  'PAYMENT_SUCCESS': 'COMPLETED',
  'PAYMENT_FAILED': 'FAILED',
  'PAYMENT_CANCELLED': 'CANCELLED',
  'ORDER_EXPIRED': 'EXPIRED',
};

const CF_REFUND_EVENT_MAP: Record<string, string> = {
  'REFUND': 'PROCESSING',
  'REFUND_SUCCESS': 'SUCCESS',
  'REFUND_FAILED': 'FAILED',
};

/**
 * Verify Cashfree webhook signature.
 */
function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  if (!config.cashfree.webhookSecret) return false;

  const signature = signatureHeader.replace(/^sha256=/i, '').trim();
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', config.cashfree.webhookSecret)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Build a deterministic idempotency key from stable Cashfree identifiers.
 */
function buildIdempotencyKey(orderId: string, eventType: string): string {
  return `movie_webhook_${orderId}_${eventType}`;
}

router.post('/cashfree', async (req: any, res: any, next: any): Promise<void> => {
  let webhookRecord: any = null;
  try {
    // 0. Raw body for signature verification
    const rawBody: Buffer = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn('[MovieWebhook] Missing raw body — possible body parsing issue');
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // 1. Verify signature BEFORE any processing
    const signature = req.headers['x-cashfree-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.warn('[MovieWebhook] Signature verification failed');
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }

    // 2. Parse payload (safe — signature already verified)
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return res.status(400).json({ success: false, error: 'Malformed JSON payload' });
    }

    const payloadData = (parsed.data as Record<string, unknown>) || parsed;
    const orderId: string | undefined = (payloadData.order_id as string | undefined) || (payloadData.orderId as string | undefined);
    const eventType: string | undefined = parsed.event_type as string | undefined;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Missing order_id' });
    }
    if (!eventType) {
      return res.status(400).json({ success: false, error: 'Missing event_type' });
    }

    // 3. Deterministic idempotency key
    const idempotencyKey = buildIdempotencyKey(orderId, eventType);

    // 4. Idempotency check — return early if already processed
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('[MovieWebhook] Already processed', { idempotencyKey, orderId, eventType });
      return res.json({ success: true, message: 'Already processed' });
    }

    // 5. Record webhook event (before processing)
    webhookRecord = await webhookEventRepository.create(eventType, idempotencyKey, parsed, orderId);

    // 6. Process the payment event
    let processed = false;
    const newStatus = CF_EVENT_MAP[eventType];

    if (newStatus === 'COMPLETED') {
      // Payment success — confirm the movie booking
      const paymentOrder = await paymentOrderRepository.findByOrderId(orderId);
      if (paymentOrder && paymentOrder.booking_type === 'movie') {
        const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
        if (booking && booking.status === 'pending_payment') {
          await movieBookingService.confirmBooking(booking.id);
          logger.info(`[MovieWebhook] Booking confirmed via webhook: ${booking.booking_reference}`);
        }
      }

      await paymentOrderRepository.updateFromWebhook(orderId, {
        status: 'COMPLETED',
        cf_payment_id: (payloadData as any).cf_payment_id || undefined,
        payment_method: (payloadData as any).payment_method || undefined,
      });
      processed = true;

    } else if (newStatus === 'FAILED' || newStatus === 'CANCELLED' || newStatus === 'EXPIRED') {
      // Payment failed — cancel the pending booking
      const paymentOrder = await paymentOrderRepository.findByOrderId(orderId);
      if (paymentOrder) {
        const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
        if (booking && booking.status === 'pending_payment') {
          await movieBookingRepository.updateStatus(booking.id, 'cancelled');
          // Release seats back
          const items = await movieBookingItemRepository.findByBooking(booking.id);
          if (items.length > 0) {
            await showtimeRepository.updateAvailableSeats(booking.showtime_id, items.length);
          }
          logger.info(`[MovieWebhook] Booking cancelled via webhook: ${booking.booking_reference}`);
        }
      }

      await paymentOrderRepository.updateFromWebhook(orderId, {
        status: newStatus,
        error_code: (payloadData as any).error_code || undefined,
        error_message: (payloadData as any).error_message || undefined,
      });
      processed = true;

    } else if (eventType.startsWith('REFUND')) {
      // Refund webhook — update payment order status
      const refundStatus = CF_REFUND_EVENT_MAP[eventType];
      if (refundStatus && paymentOrderRepository) {
        const paymentOrderForRefund = await paymentOrderRepository.findByOrderId(orderId);
        if (paymentOrderForRefund) {
          if (refundStatus === 'SUCCESS') {
            await paymentOrderRepository.updateStatus(paymentOrderForRefund.id, 'REFUNDED');
          } else if (refundStatus === 'FAILED') {
            await paymentOrderRepository.updateStatus(paymentOrderForRefund.id, 'FAILED');
          }
        }
      }
      processed = true;

    } else if (newStatus) {
      // ORDER_CREATED or other known event
      await paymentOrderRepository.updateFromWebhook(orderId, { status: newStatus });
      processed = true;
    }

    if (!processed) {
      await webhookEventRepository.markProcessed(webhookRecord.id);
      return res.json({ success: true, message: 'Ignored unknown event' });
    }

    await webhookEventRepository.markProcessed(webhookRecord.id);
    res.json({ success: true, message: 'Processed' });

  } catch (err) {
    if (typeof webhookRecord !== 'undefined' && webhookRecord?.id) {
      try {
        await webhookEventRepository.markFailed(webhookRecord.id, (err as Error).message);
      } catch {
        // best-effort
      }
    }
    next(err);
  }
});

export { router as movieWebhookRoutes, verifyWebhookSignature, buildIdempotencyKey };
