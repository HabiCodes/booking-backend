/**
 * Shared Payment Webhook Handler
 *
 * Contains the domain-agnostic business logic for processing payment webhooks:
 *   - Confirm booking when payment is COMPLETED
 *   - Cancel booking when payment FAILED/CANCELLED/EXPIRED
 *   - Process refund events
 *   - Update payment order status
 *
 * Provider-specific concerns (signature verification, event type mapping,
 * header names) are handled by each provider's webhook route before
 * delegating to this handler.
 *
 * This handler is provider-agnostic and works with any IPaymentGateway.
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfBookingService } from '../services/turfBookingService';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { movieBookingService } from '../services/movieBookingService';
import { bookingService } from '../services/bookingService';
import { eventSettlementService } from '../services/eventSettlementService';
import { refundRepository } from '../repositories/refundRepository';
import type { PaymentOrderRow, PaymentOrderStatus } from '../types';

import crypto from 'crypto';

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verify payment provider webhook HMAC signature.
 *
 * Provider-agnostic — takes the webhook secret as a parameter.
 * Each provider's webhook route supplies its own secret from config.
 */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined, webhookSecret: string): boolean {
  if (!signatureHeader) return false;
  if (!webhookSecret) return false;

  const signature = signatureHeader.replace(/^sha256=/i, '').trim();
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return crypto.timingSafeEqual(sigBuf, expBuf);
}

// ── Event type maps (generic — per-provider routes supply their own) ──────────

export const PAYMENT_EVENT_MAP: Record<string, PaymentOrderStatus> = {
  'ORDER_CREATED': 'ACTIVE',
  'PAYMENT_SUCCESS': 'COMPLETED',
  'PAYMENT_FAILED': 'FAILED',
  'PAYMENT_CANCELLED': 'CANCELLED',
  'ORDER_EXPIRED': 'EXPIRED',
};

export const REFUND_EVENT_MAP: Record<string, string> = {
  'REFUND': 'PROCESSING',
  'REFUND_SUCCESS': 'SUCCESS',
  'REFUND_FAILED': 'FAILED',
};

// ── Idempotency key builders (per domain) ─────────────────────────────────────

export function turfWebhookIdempotencyKey(orderId: string, eventType: string): string {
  return `turf_webhook_${orderId}_${eventType}`;
}

export function movieWebhookIdempotencyKey(orderId: string, eventType: string): string {
  return `movie_webhook_${orderId}_${eventType}`;
}

export function eventWebhookIdempotencyKey(orderId: string, eventType: string): string {
  return `event_webhook_${orderId}_${eventType}`;
}

// ── Processors ───────────────────────────────────────────────────────────────

export async function processBookingCompleted(paymentOrder: PaymentOrderRow, bookingType: string): Promise<boolean> {
  try {
    if (bookingType === 'event') {
      const result = await bookingService.confirmBooking(paymentOrder.booking_id);
      if (result.confirmed) {
        logger.info(`[Webhook] Event booking confirmed: booking_id=${paymentOrder.booking_id}`);
        // Create settlement record for the event organizer (fire-and-forget — not on critical path)
        eventSettlementService.createSettlementForBooking(paymentOrder.booking_id).catch((err) =>
          logger.error(`[Webhook] Event settlement failed for booking ${paymentOrder.booking_id}:`, err as Error)
        );
      }
    } else if (bookingType === 'movie') {
      const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await movieBookingService.confirmBooking(booking.id);
        logger.info(`[Webhook] Movie booking confirmed: ${booking.booking_reference}`);
      }
    } else {
      // turf (default)
      const booking = await turfBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await turfBookingService.confirmBooking(booking.id, {
          actorId: 0,
          actorType: 'webhook',
        });
        logger.info(`[Webhook] Turf booking confirmed: ${booking.booking_reference}`);
      }
    }

    await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
      status: 'COMPLETED',
      provider_payment_id: undefined,
      payment_method: undefined,
    });
    return true;
  } catch (err) {
    logger.error(`[Webhook] Confirm failed for booking_type=${bookingType}:`, err as Error);
    return false;
  }
}

export async function processBookingFailed(
  paymentOrder: PaymentOrderRow,
  eventType: string,
  bookingType: string,
): Promise<boolean> {
  try {
    if (bookingType === 'event') {
      // Cancel event booking and release capacity
      const cancelled = await bookingService.cancelBooking(paymentOrder.booking_id, undefined, 'Payment failed via webhook');
      if (cancelled) {
        logger.info(`[Webhook] Event booking cancelled: booking_id=${paymentOrder.booking_id}`);
      }
    } else if (bookingType === 'movie') {
      const booking = await movieBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await movieBookingService.cancelBooking(
          booking.id,
          booking.user_id,
          'Payment failed via webhook',
          { actorId: 0, actorType: 'webhook' },
        );
        logger.info(`[Webhook] Movie booking cancelled: ${booking.booking_reference}`);
      }
    } else {
      const booking = await turfBookingRepository.findById(paymentOrder.booking_id);
      if (booking && booking.status === 'pending_payment') {
        await turfBookingService.cancelBooking(booking.id, 0, 'Payment failed via webhook', {
          actorId: 0,
          actorType: 'webhook',
        });
        logger.info(`[Webhook] Turf booking cancelled: ${booking.booking_reference}`);
      }
    }

    await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, {
      status: eventType as PaymentOrderStatus,
      error_code: undefined,
      error_message: undefined,
    });
    return true;
  } catch (err) {
    logger.error(`[Webhook] Cancel failed for booking_type=${bookingType}:`, err as Error);
    return false;
  }
}

export async function processRefundEvent(
  paymentOrder: PaymentOrderRow,
  refundStatus: string,
): Promise<boolean> {
  try {
    if (refundStatus === 'SUCCESS') {
      const allRefunds = await refundRepository.findByPaymentOrderId(paymentOrder.id);
      const totalRefunded = allRefunds.reduce((sum, r) => sum + Number(r.amount), 0);
      if (totalRefunded >= Number(paymentOrder.amount)) {
        await paymentOrderRepository.updateStatus(paymentOrder.id, 'REFUNDED');
      } else {
        await paymentOrderRepository.updateStatus(paymentOrder.id, 'PARTIALLY_REFUNDED');
      }
    } else if (refundStatus === 'FAILED') {
      await paymentOrderRepository.updateStatus(paymentOrder.id, 'FAILED');
    }
    return true;
  } catch (err) {
    logger.error('[Webhook] Refund processing failed:', err as Error);
    return false;
  }
}

/**
 * Main entry point — process a payment webhook event.
 *
 * @param paymentOrder - The payment order from the DB
 * @param eventType - The provider's event type string
 * @param payloadData - The parsed webhook payload data
 * @returns true if processed, false if ignored
 */
export async function processPaymentWebhook(
  paymentOrder: PaymentOrderRow,
  eventType: string,
  payloadData: Record<string, unknown>,
): Promise<boolean> {
  const bookingType = paymentOrder.booking_type || 'turf';
  const newStatus = PAYMENT_EVENT_MAP[eventType];

  if (newStatus === 'COMPLETED') {
    return processBookingCompleted(paymentOrder, bookingType);
  }

  if (newStatus === 'FAILED' || newStatus === 'CANCELLED' || newStatus === 'EXPIRED') {
    return processBookingFailed(paymentOrder, newStatus, bookingType);
  }

  if (eventType.startsWith('REFUND')) {
    const refundStatus = REFUND_EVENT_MAP[eventType];
    if (refundStatus) {
      return processRefundEvent(paymentOrder, refundStatus);
    }
  }

  if (newStatus) {
    // ORDER_CREATED or other known event — just update status
    await paymentOrderRepository.updateFromWebhook(paymentOrder.order_id, { status: newStatus });
    return true;
  }

  return false; // Unknown event — caller should mark as "ignored"
}
