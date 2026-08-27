/**
 * Movie Payment Webhook Route
 *
 * Thin provider-specific wrapper. The actual business logic lives in
 * paymentWebhookHandler.ts (provider-agnostic).
 *
 * Mounted at: POST /api/v1/movies/webhooks/payment
 *
 * SECURITY:
 *  - Raw body is captured before JSON parsing so HMAC verification uses
 *    the exact bytes the provider signed.
 *  - Signature is verified BEFORE any processing.
 *  - Idempotency key is deterministic (orderId + eventType) so retries
 *    from the provider collapse to a single processing.
 */

import { Router } from 'express';
import { AppError } from '../middleware/errorHandler';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { movieBookingService } from '../services/movieBookingService';
import { logger } from '../utils/logger';
import { config } from '../config';
import { verifyWebhookSignature, processPaymentWebhook, movieWebhookIdempotencyKey } from '../services/paymentWebhookHandler';

const router = Router();

router.post('/payment', async (req: any, res: any, next: any): Promise<void> => {
  let webhookRecord: any = null;
  try {
    // 0. Raw body for signature verification
    const rawBody: Buffer = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn('[MovieWebhook] Missing raw body — possible body parsing issue');
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // 1. Verify signature BEFORE any processing
    const signature = req.headers['x-provider-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature, config.paymentProvider.webhookSecret)) {
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

    // 3. Look up payment order
    const paymentOrder = await paymentOrderRepository.findByOrderId(orderId);
    if (!paymentOrder || paymentOrder.booking_type !== 'movie') {
      logger.warn('[MovieWebhook] Payment order not found or wrong type', { orderId });
      return res.status(404).json({ success: false, error: 'Payment order not found' });
    }

    // 4. Deterministic idempotency key
    const idempotencyKey = movieWebhookIdempotencyKey(orderId, eventType);

    // 5. Idempotency check — return early if already processed
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('[MovieWebhook] Already processed', { idempotencyKey, orderId, eventType });
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

export { router as movieWebhookRoutes };
