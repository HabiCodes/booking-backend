/**
 * Unified payment webhook route — single endpoint for ALL booking categories.
 *
 * The payment provider sends all webhooks to one URL. This handler:
 *   1. Captures the raw body (already done in server.ts)
 *   2. Verifies the provider's HMAC signature
 *   3. Looks up the payment order to determine booking_type
 *   4. Delegates to the shared webhook handler for domain-agnostic processing
 *   5. Records webhook events for idempotency
 *
 * Mounted at: POST /api/v1/webhooks/payment
 *
 * SECURITY:
 *  - Raw body captured before JSON parsing for HMAC verification
 *  - Signature verified before any processing
 *  - Idempotency key: {bookingType}_webhook_{orderId}_{eventType}
 */

import { Router } from 'express';
import { AppError } from '../middleware/errorHandler';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { logger } from '../utils/logger';
import { config } from '../config';
import { verifyWebhookSignature, processPaymentWebhook } from '../services/paymentWebhookHandler';

const router = Router();

/**
 * Build a deterministic idempotency key from stable identifiers.
 */
export function buildIdempotencyKey(bookingType: string, orderId: string, eventType: string): string {
  return `${bookingType}_webhook_${orderId}_${eventType}`;
}

router.post('/payment', async (req: any, res: any, next: any): Promise<void> => {
  let webhookRecord: any = null;
  try {
    // 0. Raw body for signature verification
    const rawBody: Buffer = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn('[Webhook] Missing raw body — possible body parsing issue');
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // 1. Verify signature BEFORE any processing
    const signature = req.headers['x-provider-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature, config.paymentProvider.webhookSecret)) {
      logger.warn('[Webhook] Signature verification failed');
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

    // 3. Look up payment order to determine booking_type
    const paymentOrder = await paymentOrderRepository.findByOrderId(orderId);
    if (!paymentOrder) {
      logger.warn('[Webhook] Payment order not found', { orderId });
      return res.status(404).json({ success: false, error: 'Payment order not found' });
    }

    const bookingType = paymentOrder.booking_type;
    if (!bookingType || !['event', 'turf', 'movie'].includes(bookingType)) {
      logger.error('[Webhook] Invalid booking_type on payment order', {
        orderId,
        bookingType: paymentOrder.booking_type,
        paymentOrderId: paymentOrder.id,
      });
      return res.status(400).json({ success: false, error: 'Invalid booking type on payment order' });
    }

    // 4. Deterministic idempotency key (includes booking_type)
    const idempotencyKey = buildIdempotencyKey(bookingType, orderId, eventType);

    // 5. Idempotency check
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('[Webhook] Already processed', { idempotencyKey, orderId, eventType });
      return res.json({ success: true, message: 'Already processed' });
    }

    // 6. Record webhook event (before processing)
    webhookRecord = await webhookEventRepository.create(eventType, idempotencyKey, parsed, orderId);

    // 7. Delegate to shared handler
    const processed = await processPaymentWebhook(paymentOrder, eventType, payloadData);

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

export { router as unifiedWebhookRoutes };
