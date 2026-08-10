/**
 * Turf payment routes — uses main backend's Cashfree infrastructure.
 * Mounted at /api/v1/turf/payments
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { PaymentService, createPaymentService } from '../services/paymentService';
import { turfBookingService } from '../services/turfBookingService';
import { turfSettlementRepository } from '../repositories/turfSettlementRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { webhookEventRepository } from '../repositories/webhookEventRepository';
import { logger } from '../utils/logger';
import { config } from '../config';

const router = Router();

// Lazily create the payment service to avoid circular deps
let paymentService: PaymentService | null = null;
function getPaymentService(): PaymentService {
  if (!paymentService) {
    paymentService = createPaymentService({
      appId: config.cashfree.appId,
      secretKey: config.cashfree.secretKey,
      webhookSecret: config.cashfree.webhookSecret,
      returnUrl: config.cashfree.returnUrl,
      notifyUrl: config.cashfree.notifyUrl,
    });
  }
  return paymentService;
}

/**
 * POST /api/v1/turf/payments/create-order
 * Creates a Cashfree payment order for a Turf booking.
 */
router.post('/create-order', authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);

    const { bookingId } = req.body;
    if (!bookingId) throw new AppError('bookingId is required', 400);

    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    if (booking.status !== 'pending_payment') {
      throw new AppError('Booking is not in pending_payment state', 409);
    }

    // Get customer details
    const userResult = await (require('../db/pool').getPool()).query(
      'SELECT email, username, phone FROM users WHERE id = $1', [userId]
    );
    const user = userResult.rows[0];

    // Create payment order via main Cashfree service
    const orderId = `turf_${booking.booking_reference}`;
    const result = await getPaymentService().createOrder({
      booking_id: booking.id,
      order_id: orderId,
      orderId: orderId,
      organization_id: booking.organization_id,
      event_id: null,
      amount: parseFloat(booking.amount),
      currency: booking.currency || 'INR',
      idempotency_key: `turf_pay_${booking.id}`,
      customerEmail: user?.email || '',
      customerPhone: user?.phone || '',
      customerName: user?.username || user?.email || `User ${userId}`,
      metadata: { source: 'turf' },
    });

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/turf/payments/verify
 * Verifies payment and confirms the booking.
 */
router.post('/verify', authMiddleware, async (req, res, next) => {
  try {
    const { bookingId, gatewayOrderId, gatewayPaymentId } = req.body;
    if (!bookingId || !gatewayOrderId || !gatewayPaymentId) {
      throw new AppError('bookingId, gatewayOrderId, gatewayPaymentId required', 400);
    }

    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);

    if (booking.status !== 'pending_payment') {
      throw new AppError('Booking is not in pending_payment state', 409);
    }

    // Verify with Cashfree
    const { CashfreePaymentGateway } = await import('../services/cashfreeService');
    const gateway = new CashfreePaymentGateway({
      appId: config.cashfree.appId,
      secretKey: config.cashfree.secretKey,
      webhookSecret: config.cashfree.webhookSecret,
      returnUrl: config.cashfree.returnUrl,
      notifyUrl: config.cashfree.notifyUrl,
    });

    const verifyResult = await gateway.verifyPayment(gatewayOrderId, {
      cf_payment_id: gatewayPaymentId,
      order_id: gatewayOrderId,
    });

    if (verifyResult.success) {
      // Confirm the booking (this also generates QR, creates settlement, awards coins)
      const confirmed = await turfBookingService.confirmBooking(bookingId, {
        actorId: (req as any).user?.id || 0,
        actorType: 'customer',
      });

      res.json({ success: true, data: { status: 'confirmed', booking: confirmed } });
    } else {
      // Payment failed — cancel booking and release slot
      await turfBookingService.cancelBooking(bookingId, booking.user_id, 'Payment failed', {
        actorId: (req as any).user?.id || 0,
        actorType: 'customer',
      });

      res.json({ success: true, data: { status: 'cancelled', reason: verifyResult.errorMessage } });
    }
  } catch (err) { next(err); }
});

export { router as turfPaymentRoutes };
