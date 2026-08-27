import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { bookingService } from '../services/bookingService';
import { eventRepository } from '../repositories/eventRepository';
import { bannerRepository } from '../repositories/bannerRepository';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { generateBookingPdf } from '../services/pdfService';
import { sanitizeString, validatePhone, validateAge, validateGender } from '../middleware/validator';
import { broadcastBookingCount, broadcastNewBooking } from '../sockets';
import { FederalBankPaymentProvider } from '../services/federalBankProvider';
import { createPaymentService } from '../services/paymentService';
import { pricingEngine, PricingEngine } from '../services/pricingEngine';
import type { PricingBreakdown, FinancialSnapshot } from '../services/pricingEngine';

// ── Local PaymentService lazy initialization ───────────────────────────────────
// Uses local instance to avoid the shared singleton crash.
// Pattern matches turfPaymentRoutes.ts and promotionService.ts.
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
      if (att.gender !== undefined && att.gender !== null && !validateGender(att.gender)) {
        throw new AppError('Invalid gender', 400);
      }
    }

    const parsedEventId = Number(event_id);
    if (!Number.isFinite(parsedEventId)) {
      throw new AppError('Invalid event_id', 400);
    }

    // ── Free event: book immediately ──────────────────────────────────────────
    const event = await eventRepository.getEventById(parsedEventId);
    if (!event) throw new AppError('Event not found', 404);

    if (event.is_free) {
      const result = await bookingService.createBooking(
        req.user.id,
        parsedEventId,
        attendees
      );

      const stats = await eventRepository.getBookingStats(parsedEventId);
      broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
      broadcastNewBooking({
        bookingId: result.bookingId,
        user: { email: req.user.email },
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

    // ── Paid event: create booking + payment order ────────────────────────────
    const ticketCount = attendees.length;
    const eventPricePaise = Math.round(Number(event.price) * 100);

    // ── Authoritative pricing via PricingEngine ─────────────────────────────
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
    const paymentService = getLocalPaymentService();
    const paymentResult = await paymentService.createOrder({
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
      },
    });

    const stats = await eventRepository.getBookingStats(parsedEventId);
    broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
    broadcastNewBooking({
      bookingId: bookingResult.bookingId,
      user: { email: req.user.email },
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
