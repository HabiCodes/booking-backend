/**
 * Unified Cashfree webhook route — single endpoint for ALL booking categories.
 *
 * Cashfree sends all payment webhooks to one URL. This handler reads the
 * booking_type from the payment_order and dispatches to the correct
 * category-specific processing logic.
 *
 * Mounted at: POST /api/v1/webhooks/cashfree
 *
 * SECURITY:
 *  - Raw body captured before JSON parsing for HMAC verification
 *  - Signature verified before any processing
 *  - Idempotency key: {bookingType}_webhook_{orderId}_{eventType}
 */

import { Router } from 'express';
import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { refundRepository } from '../repositories/refundRepository';
import { turfBookingService } from '../services/turfBookingService';
import { movieBookingService } from '../services/movieBookingService';
import { logger } from '../utils/logger';
import { config } from '../config';

const router = Router();

// ── Event type maps ────────────────────────────────────────────────────────────

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

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function buildIdempotencyKey(bookingType: string, orderId: string, eventType: string): string {
  return `${bookingType}_webhook_${orderId}_${eventType}`;
}

// ── Category-specific processors ───────────────────────────────────────────────

async function processTurfCompleted(paymentOrder: any, payloadData: Record<string, unknown>): Promise<boolean> {
  try {
    const booking = await turfBookingRepository.findById(paymentOrder.booking_id);
    if (booking && booking.status === 'pending_payment') {
      await turfBookingService.confirmBooking(booking.id, {
        actorId: 0,
        actorType: 'webhook',
      });
      logger.info(`[UnifiedWebhook] Turf booking confirmed via webhook: ${booking.booking_reference}`);
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Turf confirm failed:', err as Error);
    return false;
  }

  await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
    status: 'COMPLETED',
    cf_payment_id: (payloadData as any).cf_payment_id || undefined,
    payment_method: (payloadData as any).payment_method || undefined,
  });
  return true;
}

async function processTurfFailed(
  paymentOrder: any,
  eventType: string,
  payloadData: Record<string, unknown>,
): Promise<boolean> {
  try {
    const booking = await turfBookingRepository.findById(paymentOrder.booking_id);
    if (booking && booking.status === 'pending_payment') {
      await turfBookingService.cancelBooking(booking.id, 0, 'Payment failed via Cashfree webhook', {
        actorId: 0,
        actorType: 'cashfree_webhook',
      });
      logger.info(`[UnifiedWebhook] Turf booking cancelled via webhook: ${booking.booking_reference}`);
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Turf cancel failed:', err as Error);
    return false;
  }

  await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
    status: eventType,
    error_code: (payloadData as any).error_code || undefined,
    error_message: (payloadData as any).error_message || undefined,
  });
  return true;
}

async function processTurfRefund(
  paymentOrder: any,
  eventType: string,
  refundStatus: string,
  parsed: Record<string, unknown>,
): Promise<boolean> {
  try {
    const refundData = (parsed.data as Record<string, unknown>).refund as Record<string, unknown> || {};
    const cfRefundId = refundData.refund_id as string | undefined;

    if (cfRefundId) {
      const matchingRefunds = await refundRepository.findByPaymentOrderId(paymentOrder.id);
      for (const r of matchingRefunds) {
        const status =
          refundStatus === 'SUCCESS' ? 'SUCCESS' :
          refundStatus === 'FAILED' ? 'FAILED' : 'PROCESSING';
        await refundRepository.updateStatus(r.id, status, { cf_refund_id: cfRefundId });
      }

      if (refundStatus === 'SUCCESS') {
        const allRefunds = await refundRepository.findByPaymentOrderId(paymentOrder.id);
        const totalRefunded = allRefunds.reduce((sum, r) => sum + Number(r.amount), 0);
        if (totalRefunded >= Number(paymentOrder.amount)) {
          await paymentOrderRepository.updateStatus(paymentOrder.id, 'REFUNDED');
        } else {
          await paymentOrderRepository.updateStatus(paymentOrder.id, 'PARTIALLY_REFUNDED');
        }
      }
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Turf refund processing failed:', err as Error);
    return false;
  }
  return true;
}

async function processMovieCompleted(paymentOrder: any, payloadData: Record<string, unknown>): Promise<boolean> {
  try {
    if (paymentOrder.booking_type === 'movie') {
      const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await movieBookingService.confirmBooking(booking.id);
        logger.info(`[UnifiedWebhook] Movie booking confirmed via webhook: ${booking.booking_reference}`);
      }
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Movie confirm failed:', err as Error);
    return false;
  }

  await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
    status: 'COMPLETED',
    cf_payment_id: (payloadData as any).cf_payment_id || undefined,
    payment_method: (payloadData as any).payment_method || undefined,
  });
  return true;
}

async function processMovieFailed(
  paymentOrder: any,
  eventType: string,
  payloadData: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (paymentOrder.booking_type === 'movie') {
      const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await movieBookingService.cancelBooking(
          booking.id,
          booking.user_id,
          'Payment failed via Cashfree webhook',
          { actorId: 0, actorType: 'cashfree_webhook' },
        );
        logger.info(`[UnifiedWebhook] Movie booking cancelled via webhook: ${booking.booking_reference}`);
      }
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Movie cancel failed:', err as Error);
    return false;
  }

  await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
    status: eventType,
    error_code: (payloadData as any).error_code || undefined,
    error_message: (payloadData as any).error_message || undefined,
  });
  return true;
}

async function processMovieRefund(
  paymentOrder: any,
  refundStatus: string,
): Promise<boolean> {
  try {
    if (refundStatus === 'SUCCESS') {
      await paymentOrderRepository.updateStatus(paymentOrder.id, 'REFUNDED');
    } else if (refundStatus === 'FAILED') {
      await paymentOrderRepository.updateStatus(paymentOrder.id, 'FAILED');
    }
  } catch (err) {
    logger.error('[UnifiedWebhook] Movie refund processing failed:', err as Error);
    return false;
  }
  return true;
}

// ── Main handler ───────────────────────────────────────────────────────────────

router.post('/cashfree', async (req: any, res: any, next: any): Promise<void> => {
  let webhookRecord: any = null;
  try {
    // 0. Raw body for signature verification
    const rawBody: Buffer = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      logger.warn('[UnifiedWebhook] Missing raw body — possible body parsing issue');
      return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    // 1. Verify signature BEFORE any processing
    const signature = req.headers['x-cashfree-signature'] as string | undefined;
    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.warn('[UnifiedWebhook] Signature verification failed');
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
      logger.warn('[UnifiedWebhook] Payment order not found', { orderId });
      return res.status(404).json({ success: false, error: 'Payment order not found' });
    }

    const bookingType = paymentOrder.booking_type || 'turf';

    // 4. Deterministic idempotency key (includes booking_type)
    const idempotencyKey = buildIdempotencyKey(bookingType, orderId, eventType);

    // 5. Idempotency check
    const existing = await webhookEventRepository.findByIdempotencyKey(idempotencyKey);
    if (existing?.processed_at) {
      logger.info('[UnifiedWebhook] Already processed', { idempotencyKey, orderId, eventType });
      return res.json({ success: true, message: 'Already processed' });
    }

    // 6. Record webhook event (before processing)
    webhookRecord = await webhookEventRepository.create(eventType, idempotencyKey, parsed, orderId);

    // 7. Process based on booking_type + event
    let processed = false;
    const newStatus = CF_EVENT_MAP[eventType];

    if (newStatus === 'COMPLETED') {
      if (bookingType === 'movie') {
        processed = await processMovieCompleted(paymentOrder, payloadData);
      } else {
        // turf (and event — though events don't use Cashfree)
        processed = await processTurfCompleted(paymentOrder, payloadData);
      }
    } else if (newStatus === 'FAILED' || newStatus === 'CANCELLED' || newStatus === 'EXPIRED') {
      if (bookingType === 'movie') {
        processed = await processMovieFailed(paymentOrder, eventType, payloadData);
      } else {
        processed = await processTurfFailed(paymentOrder, eventType, payloadData);
      }
    } else if (eventType.startsWith('REFUND')) {
      const refundStatus = CF_REFUND_EVENT_MAP[eventType];
      if (refundStatus) {
        if (bookingType === 'movie') {
          processed = await processMovieRefund(paymentOrder, refundStatus);
        } else {
          processed = await processTurfRefund(paymentOrder, eventType, refundStatus, parsed);
        }
      }
    } else if (newStatus) {
      // ORDER_CREATED or other known event — just update status
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

export { router as unifiedWebhookRoutes };
