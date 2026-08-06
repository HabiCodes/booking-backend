import { withTransaction } from '../db/pool';
import { eventRepository } from '../repositories/eventRepository';
import { userRepository } from '../repositories/userRepository';
import { bookingRepository } from '../repositories/bookingRepository';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import type { BookingRow, AttendeeInput } from '../types';

export class BookingService {
  /**
   * Create a booking atomically:
   *   1. Lock the event row (FOR UPDATE)
   *   2. Reserve capacity from `events.remaining_capacity`
   *   3. Insert the booking row
   *   4. Insert individual tickets (one at a time with immediate RETURNING)
   *   5. Commit → all-or-nothing
   */
  async createBooking(userId: number, eventId: number, attendees: AttendeeInput[]) {
    const ticketCount = attendees.length;

    // ── Rule: at least 1 ticket ───────────────────────────────────────────────
    if (ticketCount < 1) throw new AppError('At least 1 ticket required', 400);

    // ── Rule: max tickets per booking ────────────────────────────────────────
    const maxPerBooking = config.bookings.maxTicketsPerBooking;
    if (ticketCount > maxPerBooking) {
      throw new AppError(
        `You can book at most ${maxPerBooking} tickets at once`,
        400
      );
    }

    // ── Event existence ──────────────────────────────────────────────────────
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.status !== 'published') throw new AppError('This event is not open for booking', 400);

    // ── Rule: per-user-per-event cap ─────────────────────────────────────────
    const maxPerUser = config.bookings.maxTicketsPerUserPerEvent;
    const existingCount = await bookingRepository.getUserBookedCount(userId, eventId);
    if (existingCount + ticketCount > maxPerUser) {
      throw new AppError(
        `Booking limit reached. You already have ${existingCount} ticket(s) for this event. Limit is ${maxPerUser} per user.`,
        403
      );
    }

    // ── Rule: cancellation window check ──────────────────────────────────────
    if (event.cancellable_until && new Date() > new Date(event.cancellable_until)) {
      throw new AppError('This event has passed its cancellation window and cannot be booked with refund.', 400);
    }

    // ── Atomic booking + capacity reservation ────────────────────────────────
    const { booking, tickets } = await withTransaction(async (client) => {
      // Lock event row and atomically reserve capacity
      const newRemaining = await bookingRepository.reserveCapacity(client, eventId, ticketCount);
      if (newRemaining < 0) {
        throw new AppError('Not enough tickets available — please try again.', 409);
      }

      // Insert booking row
      const bookingId = await bookingRepository.createBooking(client, userId, eventId, ticketCount);

      // Insert tickets (one-at-a-time with RETURNING)
      const insertedTickets = await bookingRepository.createTickets(client, bookingId, attendees);

      // Sign each ticket with HMAC
      await bookingRepository.signTickets(insertedTickets, eventId, event.start_at, client);

      return {
        booking: {
          id: bookingId,
          user_id: userId,
          event_id: eventId,
          ticket_count: ticketCount,
          status: 'pending' as const,
          cancelled_at: null,
          cancellation_reason: null,
          deleted_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        tickets: insertedTickets,
      };
    });

    // Audit log (async — don't block the response)
    bookingRepository.writeBookingAudit(
      booking.id, null, 'user', userId,
      'booking_created',
      { eventId, ticketCount, eventTitle: event.title }
    ).catch(() => {});

    return { bookingId: booking.id, tickets };
  }

  /**
   * Cancel a confirmed booking:
   *   1. Lock the booking row (FOR UPDATE)
   *   2. Verify the booking is in a cancellable state
   *   3. Check the event's cancellation window
   *   4. Mark booking cancelled
   *   5. Release capacity back to the event
   */
  async cancelBooking(bookingId: number, userId: number, reason: string | undefined) {
    // Verify the booking exists and belongs to this user
    const existing = await bookingRepository.getBookingWithTickets(bookingId, userId);
    if (!existing) throw new AppError('Booking not found', 404);

    if (existing.booking.status === 'cancelled') {
      throw new AppError('Booking is already cancelled', 400);
    }
    if (existing.booking.status === 'attended') {
      throw new AppError('Cannot cancel a booking that has already been attended', 400);
    }

    // Check cancellation window on the event
    const event = await eventRepository.getEventById(existing.booking.event_id);
    if (event?.cancellable_until && new Date() > new Date(event.cancellable_until)) {
      throw new AppError(
        'This booking is past the cancellation window and cannot be cancelled for a refund.',
        403
      );
    }

    // Atomic cancel + capacity release
    const result = await bookingRepository.cancelBooking(bookingId, userId, reason ?? null);

    if (!result.cancelled) {
      throw new AppError('Failed to cancel booking', 500);
    }

    // Audit log
    bookingRepository.writeBookingAudit(
      bookingId, null, 'user', userId,
      'booking_cancelled',
      { ticketCount: result.ticketCount, eventId: result.eventId, reason }
    ).catch(() => {});

    return {
      cancelled: true,
      bookingId,
      ticketCount: result.ticketCount,
      refundEligible: event?.cancellable_until ? new Date() <= new Date(event.cancellable_until) : true,
    };
  }

  async getBooking(bookingId: number, userId: number) {
    const booking = await bookingRepository.getBookingWithTickets(bookingId, userId);
    if (!booking) throw new AppError('Booking not found', 404);
    return booking;
  }

  async getMyBookings(userId: number) {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT b.*, e.title AS event_title, e.venue AS event_venue, e.start_at AS event_start_at
         FROM bookings b
         INNER JOIN events e ON b.event_id = e.id
         WHERE b.user_id = $1
         ORDER BY b.created_at DESC`,
        [userId]
      );
      return result.rows;
    });

    return rows as unknown as Array<BookingRow & {
      event_title: string;
      event_venue: string;
      event_start_at: Date;
    }>;
  }
}

export const bookingService = new BookingService();
