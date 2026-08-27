/**
 * Turf Payment Webhook Route
 *
 * Thin provider-specific wrapper. The actual business logic lives in
 * paymentWebhookHandler.ts (provider-agnostic).
 *
 * Mounted at: POST /api/v1/turf/webhooks/payment
 *
 * NOTE: The unified webhook at /api/v1/webhooks/payment is the primary
 * endpoint. This route exists for backward compatibility and can be
 * removed once the provider updates their webhook configuration.
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
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfBookingService } from '../services/turfBookingService';
import { refundRepository } from '../repositories/refundRepository';
import { logger } from '../utils/logger';
import { config } from '../config';
import { verifyWebhookSignature, processPaymentWebhook, turfWebhookIdempotencyKey } from '../services/paymentWebhookHandler';

const router = Router();

router.post('/payment', async (req: any, res: any, next: any): Promise<void> => {
  let webhookRecord: any = null;
  try {
    // ── 0. Raw body for signature verification ─────────────────────────────
    const rawBody: Buffer = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn('[TurfWebhook] Missing raw body — possible body parsing issue');
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // ── 1. Verify signature BEFORE any processing ─────────────────────────
    const signature = req.headers['x-provider-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature, config.paymentProvider.webhookSecret)) {
      logger.warn('[TurfWebhook] Signature verification failed');
      return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
    }

    // ── 2. Parse payload (safe — signature already verified) ──────────────
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

    // ── 3. Look up payment order ───────────────────────────────────────────
    const paymentOrder = await paymentOrderRepository.findByOrderId(orderId);
    if (!paymentOrder || paymentOrder.booking_type !== 'turf') {
      logger.warn('[TurfWebhook] Payment order not found or wrong type', { orderId });
      return res.status(404).json({ success: false, error: 'Payment order not found' });
    }

    // ── 4. Deterministic idempotency key ──────────────────────────────────
    const idempotencyKey = turfWebhookIdempotencyKey(orderId, eventType);

    // ── 5. Idempotency check ──────────────────────────────────────────────
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('[TurfWebhook] Already processed', { idempotencyKey, orderId, eventType });
      return res.json({ success: true, message: 'Already processed' });
    }

    // ── 6. Record webhook event (before processing) ───────────────────────
    webhookRecord = await webhookEventRepository.create(eventType, idempotencyKey, parsed, orderId);

    // ── 7. Delegate to shared handler ─────────────────────────────────────
    const processed = await processPaymentWebhook(paymentOrder, eventType, payloadData);

    if (!processed) {
      await webhookEventRepository.markProcessed(webhookRecord.id);
      return res.json({ success: true, message: 'Ignored unknown event' });
    }

    await webhookEventRepository.markProcessed(webhookRecord.id);
    res.json({ success: true, message: 'Processed' });

  } catch (err) {
    // Mark as failed so retries know not to re-attempt a broken event
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

export { router as turfWebhookRoutes };
