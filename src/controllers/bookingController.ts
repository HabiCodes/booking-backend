import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { bookingService } from '../services/bookingService';
import { eventRepository } from '../repositories/eventRepository';
import { eventZoneRepository } from '../repositories/eventZoneRepository';
import { bannerRepository } from '../repositories/bannerRepository';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { generateBookingPdf } from '../services/pdfService';
import { sanitizeString, validatePhone, validateAge, validateGender } from '../middleware/validator';
import { broadcastBookingCount, broadcastNewBooking } from '../sockets';
import { logger } from '../utils/logger';
import { FederalBankPaymentProvider } from '../services/federalBankProvider';
import { createPaymentService } from '../services/paymentService';
import { pricingEngine, PricingEngine } from '../services/pricingEngine';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import type { PricingBreakdown, FinancialSnapshot } from '../services/pricingEngine';

// ── Local PaymentService lazy initialization ───────────────────────────────────
let paymentService: ReturnType<typeof createPaymentService> | null = null;
function getLocalPaymentService() {
  if (!paymentService) {
    const provider = new FederalBankPaymentProvider(config.paymentProvider);
    paymentService = createPaymentService(provider);
  }
  return paymentService;
}

export async function createBooking(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);

    const { event_id, attendees } = req.body;
    const zone_id = req.body.zone_id ? Number(req.body.zone_id) : undefined;

    if (event_id === undefined || event_id === null) {
      throw new AppError('event_id is required', 400);
    }
    if (!Array.isArray(attendees) || attendees.length === 0) {
      throw new AppError('attendees array is required', 400);
    }

    for (const att of attendees) {
      if (!att.full_name || !att.phone) {
        throw new AppError('Each attendee requires full_name and phone', 400);
      }
      if (!validatePhone(att.phone)) {
        throw new AppError(`Invalid phone number: ${att.phone}`, 400);
      }
      if (att.age !== undefined && att.age !== null && !validateAge(String(att.age))) {
        throw new AppError('Invalid age', 400);
      }
      if (att.gender !== undefined && att.gender !== null && !validateGender(String(att.gender))) {
        throw new AppError('Invalid gender', 400);
      }
    }

    const parsedEventId = Number(event_id);
    if (!Number.isFinite(parsedEventId)) {
      throw new AppError('Invalid event_id', 400);
    }

    // ── Fetch event ────────────────────────────────────────────────────────────
    const event = await eventRepository.getEventById(parsedEventId);
    if (!event) throw new AppError('Event not found', 404);

    // ── FREE EVENT FLOW: book immediately, no payment ─────────────────────────
    if (event.is_free) {
      if (zone_id !== undefined) {
        throw new AppError('Free events do not support zone selection', 400);
      }

      const result = await bookingService.createBooking(
        req.user.id,
        parsedEventId,
        attendees
      );

      const stats = await eventRepository.getBookingStats(parsedEventId);
      broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
      broadcastNewBooking({
        bookingId: result.bookingId,
        user: { email: (req.user as any).email },
        eventId: parsedEventId,
        ticketCount: attendees.length,
      });

      res.status(201).json({
        success: true,
        data: {
          bookingId: result.bookingId,
          ticketCount: attendees.length,
          status: 'confirmed',
          tickets: result.tickets.map((t) => ({
            ticketUuid: t.ticket_uuid,
            attendeeName: t.attendee_name,
            attendeePhone: t.attendee_phone,
            signature: t.signature,
          })),
        },
      });
      return;
    }

    // ── Determine event type ───────────────────────────────────────────────────
    const eventZones = await eventZoneRepository.getActiveZonesByEvent(parsedEventId);

    // ── LAYOUT-BASED PAID EVENT: requires zone_id ──────────────────────────────
    if (eventZones.length > 0) {
      if (!zone_id) {
        throw new AppError('zone_id is required for this event — please select a zone', 400);
      }

      const ticketCount = attendees.length;
      const result = await bookingService.createZoneBooking(
        req.user.id,
        parsedEventId,
        zone_id,
        attendees
      );

      // Pricing from zone price
      const pricingBreakdown = pricingEngine.calculate({
        domain: 'event',
        unitPricePaise: result.zonePricePaise,
        quantity: ticketCount,
      });

      // Create payment order
      const orderId = `evt_${result.bookingId}_${Date.now()}`;
      const paymentSvc = getLocalPaymentService();
      const paymentResult = await paymentSvc.createOrder({
        booking_id: result.bookingId,
        event_id: parsedEventId,
        order_id: orderId,
        organization_id: event.organization_id ?? 0,
        amount: pricingBreakdown.totalPaise,
        currency: event.currency || 'INR',
        idempotency_key: `evt_pay_zone_${result.bookingId}`,
        customerEmail: (req.user as any).email || '',
        customerPhone: (req.user as any).phone || '',
        customerName: (req.user as any).username || (req.user as any).email || `User ${req.user.id}`,
        orderId,
        financial_snapshot: PricingEngine.toSnapshot(pricingBreakdown, 'online') as unknown as Record<string, unknown>,
        metadata: {
          source: 'event',
          ticketCount,
          zone_id: zone_id,
          zone_name: result.zoneName,
          event_type: 'layout_based',
        },
      });

      const stats = await eventRepository.getBookingStats(parsedEventId);
      broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
      broadcastNewBooking({
        bookingId: result.bookingId,
        user: { email: (req.user as any).email },
        eventId: parsedEventId,
        ticketCount,
      });

      res.status(202).json({
        success: true,
        data: {
          bookingId: result.bookingId,
          status: 'payment_pending',
          ticketCount,
          tickets: result.tickets.map((t) => ({
            ticketUuid: t.ticket_uuid,
            attendeeName: t.attendee_name,
            attendeePhone: t.attendee_phone,
            signature: t.signature,
          })),
          zone: {
            zoneId: result.zoneId,
            zoneName: result.zoneName,
            unitPricePaise: result.zonePricePaise,
          },
          payment: {
            orderId: paymentResult.order.order_id,
            amount: pricingBreakdown.totalPaise,
            currency: event.currency || 'INR',
            paymentSessionId: paymentResult.paymentSessionId,
          },
        },
      });
      return;
    }

    // ── NORMAL PAID EVENT: standard flow ─────────────────────────────────────
    const ticketCount = attendees.length;
    const eventPricePaise = Math.round(Number(event.price) * 100);

    const pricingBreakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: eventPricePaise,
      quantity: ticketCount,
    });

    const bookingResult = await bookingService.createBooking(
      req.user.id,
      parsedEventId,
      attendees
    );

    // Fetch user details for payment
    const userResult = await (require('../db/pool').getPool()).query(
      'SELECT email, username, phone FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];

    // Create payment order via universal payment service
    const orderId = `evt_${bookingResult.bookingId}_${Date.now()}`;
    const paymentSvc = getLocalPaymentService();
    const paymentResult = await paymentSvc.createOrder({
      booking_id: bookingResult.bookingId,
      event_id: parsedEventId,
      order_id: orderId,
      organization_id: event.organization_id ?? 0,
      amount: pricingBreakdown.totalPaise,
      currency: event.currency || 'INR',
      idempotency_key: `evt_pay_${bookingResult.bookingId}`,
      customerEmail: user?.email || '',
      customerPhone: user?.phone || '',
      customerName: user?.username || user?.email || `User ${req.user.id}`,
      orderId,
      financial_snapshot: PricingEngine.toSnapshot(pricingBreakdown, 'online') as unknown as Record<string, unknown>,
      metadata: {
        source: 'event',
        ticketCount,
        event_type: 'normal',
      },
    });

    const stats = await eventRepository.getBookingStats(parsedEventId);
    broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
    broadcastNewBooking({
      bookingId: bookingResult.bookingId,
      user: { email: (req.user as any).email },
      eventId: parsedEventId,
      ticketCount: attendees.length,
    });

    // Return 202 Accepted — booking is in payment_pending state
    res.status(202).json({
      success: true,
      data: {
        bookingId: bookingResult.bookingId,
        status: 'payment_pending',
        ticketCount: attendees.length,
        tickets: bookingResult.tickets.map((t) => ({
          ticketUuid: t.ticket_uuid,
          attendeeName: t.attendee_name,
          attendeePhone: t.attendee_phone,
          signature: t.signature,
        })),
        payment: {
          orderId: paymentResult.order.order_id,
          amount: pricingBreakdown.totalPaise,
          currency: event.currency || 'INR',
          paymentSessionId: paymentResult.paymentSessionId,
        },
      },
    });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function cancelBooking(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);

    const bookingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bookingId)) {
      throw new AppError('Invalid booking id', 400);
    }

    const { reason } = req.body;
    const result = await bookingService.cancelBooking(bookingId, req.user.id, reason);

    res.json({
      success: true,
      data: result,
    });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getMyBookings(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const bookings = await bookingService.getMyBookings(req.user.id);
    res.json({ success: true, data: bookings });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getBookingPdf(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);

    const bookingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bookingId)) {
      throw new AppError('Invalid booking id', 400);
    }

    const { booking, tickets } = await bookingService.getBooking(bookingId, req.user.id);
    const event = await eventRepository.getEventById(booking.event_id);
    if (!event) throw new AppError('Event not found', 404);

    // Fetch the active ticket advertisement banner (best-effort)
    const banner = await bannerRepository.getActiveBannerByPlacement('ticket_advertisement');
    let bannerImage: Buffer | null = null;
    if (banner) {
      const fs = await import('fs');
      const path = await import('path');
      const baseDir = path.resolve(config.uploads.baseDir);
      const localPath = path.join(baseDir, banner.image_url.replace(/^\/uploads\//, ''));
      if (fs.existsSync(localPath)) {
        bannerImage = fs.readFileSync(localPath);
      }
    }

    const pdfBuffer = await generateBookingPdf({ event, tickets, bannerImage });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-${bookingId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    res.end(pdfBuffer);
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getBookingDetails(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const bookingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bookingId)) {
      throw new AppError('Invalid booking id', 400);
    }
    const { booking, tickets } = await bookingService.getBooking(bookingId, req.user.id);
    res.json({ success: true, data: { booking, tickets } });
    return;
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/bookings/:id/verify
 * Verify payment status for a pending event booking — called after customer
 * returns from the payment gateway. Mirrors turf's POST /api/v1/turf/payments/verify
 * and movies' POST /api/v1/movies/bookings/confirm.
 */
export async function verifyPayment(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);

    const bookingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bookingId)) {
      throw new AppError('Invalid booking id', 400);
    }

    // Fetch booking to verify ownership and status
    const { booking } = await bookingService.getBooking(bookingId, req.user.id);

    if (booking.status !== 'payment_pending') {
      // Already resolved — return current state
      res.json({
        success: true,
        data: {
          bookingId: booking.id,
          status: booking.status,
          message: booking.status === 'confirmed'
            ? 'Payment already confirmed'
            : booking.status === 'cancelled'
              ? 'Booking was cancelled'
              : `Booking is in ${booking.status} state`,
        },
      });
      return;
    }

    // Find the payment order for this booking
    const paymentOrder = await paymentOrderRepository.findByBookingId(bookingId);
    if (!paymentOrder) {
      throw new AppError('Payment order not found for this booking', 404);
    }

    // Verify with payment provider
    const paymentSvc = getLocalPaymentService();
    const updatedOrder = await paymentSvc.verifyPayment(paymentOrder.order_id);

    if (updatedOrder.status === 'COMPLETED') {
      // Payment confirmed — confirm the booking
      const confirmed = await bookingService.confirmBooking(bookingId);
      logger.info(`[VerifyPayment] Event booking confirmed after verify: booking_id=${bookingId}`);
      res.json({
        success: true,
        data: {
          bookingId,
          status: 'confirmed',
          confirmed,
          message: 'Payment verified and booking confirmed',
        },
      });
      return;
    } else if (updatedOrder.status === 'FAILED' || updatedOrder.status === 'CANCELLED' || updatedOrder.status === 'EXPIRED') {
      // Payment not completed — cancel booking and release capacity
      const cancelled = await bookingService.cancelBooking(
        bookingId,
        req.user.id,
        `Payment ${updatedOrder.status.toLowerCase()} — verified by customer`,
      );
      res.json({
        success: true,
        data: {
          bookingId,
          status: 'cancelled',
          cancelled,
          reason: `Payment ${updatedOrder.status.toLowerCase()}`,
        },
      });
      return;
    }

    // Still pending (ACTIVE) — return current state
    res.json({
      success: true,
      data: {
        bookingId,
        status: 'payment_pending',
        message: 'Payment is still processing',
      },
    });
  } catch (err) {
    return next(err);
  }
}
