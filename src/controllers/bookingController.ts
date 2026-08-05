import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';
import { bookingService } from '../services/bookingService';
import { eventRepository } from '../repositories/eventRepository';
import { AppError } from '../middleware/errorHandler';
import { generateBookingPdf } from '../services/pdfService';
import { sanitizeString, validatePhone, validateAge, validateGender } from '../middleware/validator';
import { broadcastBookingCount, broadcastNewBooking } from '../sockets';

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

    const bookingId = await bookingService.createBooking(
      req.user.id,
      parsedEventId,
      attendees
    );

    const stats = await eventRepository.getBookingStats(parsedEventId);
    broadcastBookingCount(parsedEventId, stats.bookedCount, stats.capacity);
    broadcastNewBooking({
      bookingId,
      user: { email: req.user.email },
      eventId: parsedEventId,
      ticketCount: attendees.length,
    });

    res.status(201).json({
      success: true,
      data: {
        bookingId,
        ticketCount: attendees.length,
      },
    });
  } catch (err) {
    next(err);
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
  } catch (err) {
    next(err);
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

    const pdfBuffer = await generateBookingPdf({ event, tickets });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="tickets-${bookingId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    res.end(pdfBuffer);
  } catch (err) {
    next(err);
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
  } catch (err) {
    next(err);
  }
}
