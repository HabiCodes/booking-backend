import { withTransaction } from '../db/pool';
import { eventRepository } from '../repositories/eventRepository';
import { logger } from '../utils/logger';
import { userRepository } from '../repositories/userRepository';
import { bookingRepository } from '../repositories/bookingRepository';
import { eventZoneRepository } from '../repositories/eventZoneRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { UniversalTicketService, DOMAIN_PREFIXES } from '../services/universalTicketService';
import type { BookingRow, AttendeeInput, EventRow, EventZoneRow } from '../types';

// Re-export for controllers
export type { BookingRow, AttendeeInput };

export class BookingService {
  /**
   * Create a booking atomically.
   *
   * FREE EVENT FLOW:
   *   1. Lock event row (FOR UPDATE)
   *   2. Reserve capacity
   *   3. Insert booking → status: 'confirmed'
   *   4. Generate UUIDs with UniversalTicketService
   *   5. Insert tickets with HMAC signatures
   *   6. Commit → user gets confirmed tickets immediately
   *
   * PAID EVENT FLOW:
   *   1. Lock event row (FOR UPDATE)
   *   2. Reserve capacity
   *   3. Insert booking → status: 'payment_pending'
   *   4. Create payment order via PaymentService (caller provides orderId)
   *   5. Return bookingId + paymentOrderId → frontend opens payment
   *   6. On payment success → confirmBooking() transitions to 'confirmed'
   */
  async createBooking(userId: number, eventId: number, attendees: AttendeeInput[], opts?: {
    paymentOrderId?: string;
    paymentSessionId?: string;
  }): Promise<{
    bookingId: number;
    tickets: Array<{ ticket_uuid: string; attendee_name: string; attendee_phone: string; signature: string }>;
    paymentRequired: boolean;
    paymentOrderId?: string;
    paymentSessionId?: string;
  }> {
    const ticketCount = attendees.length;

    // ── Rule: at least 1 ticket ───────────────────────────────────────────────
    if (ticketCount < 1) {
      throw new AppError('At least 1 ticket required', 400);
    }

    // ── Rule: max tickets per booking ────────────────────────────────────────
    const maxPerBooking = config.bookings.maxTicketsPerBooking;
    if (ticketCount > maxPerBooking) {
      throw new AppError(
        `You can book at most ${maxPerBooking} tickets at once`,
        400
      );
    }

    // ── Event existence + pre-checks ─────────────────────────────────────────
    const event = await eventRepository.getEventById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404);
    }
    if (event.status !== 'published') {
      throw new AppError('This event is not open for booking', 400);
    }
    if (event.is_free && Number(event.price) !== 0) {
      throw new AppError('Free event must have price = 0', 500);
    }
    if (!event.is_free && (Number(event.price) <= 0 || Number(event.price) > 999999)) {
      throw new AppError('Paid event must have a valid price between 0 and 999999', 400);
    }

    // ── Rule: per-user-per-event cap (free events are capped at 2 tickets) ──
    const maxPerUser = event.is_free
      ? config.bookings.maxTicketsPerUserPerFreeEvent
      : config.bookings.maxTicketsPerUserPerEvent;
    const existingCount = await bookingRepository.getUserBookedCount(userId, eventId);
    if (existingCount + ticketCount > maxPerUser) {
      if (event.is_free) {
        throw new AppError(
          `Free event booking limit reached. You already have ${existingCount} ticket(s) for this event. Maximum ${maxPerUser} tickets per user for free events.`,
          403
        );
      }
      throw new AppError(
        `Booking limit reached. You already have ${existingCount} ticket(s) for this event. Limit is ${maxPerUser} per user.`,
        403
      );
    }

    // ── Atomic booking + capacity reservation ────────────────────────────────
    const result = await withTransaction(async (client) => {
      // Lock event row and atomically reserve capacity
      const newRemaining = await bookingRepository.reserveCapacity(client, eventId, ticketCount);
      if (newRemaining < 0) {
        throw new AppError('Not enough tickets available — please try again.', 409);
      }

      // Determine initial booking status
      const isFree = event.is_free;
      const initialStatus = isFree ? 'confirmed' : 'payment_pending';

      // Insert booking row
      const bookingId = await bookingRepository.createBooking(client, userId, eventId, ticketCount, initialStatus);

      // Generate ticket UUIDs with UniversalTicketService (domain-prefixed)
      const ticketUuids = attendees.map((_, idx) =>
        UniversalTicketService.generateTicketUuid('event')
      );

      // Insert tickets with generated UUIDs and initial status
      const insertedTickets = await bookingRepository.createTicketsWithUuids(
        client, bookingId, attendees, ticketUuids
      );

      // Sign each ticket with HMAC via UniversalTicketService
      const signedTickets = insertedTickets.map(t => ({
        ...t,
        signature: UniversalTicketService.sign({
          domain: 'event',
          ticketUuid: t.ticket_uuid,
          entityId: eventId,
          startAt: event.start_at,
        }),
      }));

      // Persist signatures
      for (const t of signedTickets) {
        await client.query(
          'UPDATE tickets SET signature = $1 WHERE id = $2',
          [t.signature, t.id]
        );
      }

      return {
        bookingId,
        tickets: signedTickets,
        initialStatus,
      };
    });

    // Audit log (async — don't block the response)
    bookingRepository.writeBookingAudit(
      result.bookingId, null, 'user', userId,
      result.initialStatus === 'confirmed' ? 'booking_created_free' : 'booking_created_pending',
      { eventId, ticketCount, eventTitle: event.title, isFree: event.is_free }
    ).catch((err) => {
      logger.warn('Booking audit log write failed', {
        bookingId: result.bookingId,
        actor: 'user',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Free event: tickets are immediately valid, no payment needed
    if (event.is_free) {
      return {
        bookingId: result.bookingId,
        tickets: result.tickets.map(t => ({
          ticket_uuid: t.ticket_uuid,
          attendee_name: t.attendee_name,
          attendee_phone: t.attendee_phone,
          signature: t.signature,
        })),
        paymentRequired: false,
      };
    }

    // Paid event: payment order should have been created by the controller
    return {
      bookingId: result.bookingId,
      tickets: result.tickets.map(t => ({
        ticket_uuid: t.ticket_uuid,
        attendee_name: t.attendee_name,
        attendee_phone: t.attendee_phone,
        signature: t.signature,
      })),
      paymentRequired: true,
      paymentOrderId: opts?.paymentOrderId,
      paymentSessionId: opts?.paymentSessionId,
    };
  }

  /**
   * Create a booking for a LAYOUT-BASED PAID EVENT (zone-based pricing).
   *
   * Flow:
   *   1. Validate event exists, is published, has zones
   *   2. Validate zone_id is provided and zone is active
   *   3. Check zone capacity >= ticketCount
   *   4. Atomically reserve zone capacity AND event global capacity
   *   5. Insert booking (status: 'payment_pending')
   *   6. Generate UUIDs + sign tickets
   *   7. Insert tickets
   *   8. Record booking_zone join row
   *   9. Return bookingId + zone info for payment calculation
   */
  async createZoneBooking(
    userId: number,
    eventId: number,
    zoneId: number,
    attendees: AttendeeInput[],
    opts?: {
      paymentOrderId?: string;
      paymentSessionId?: string;
    }
  ): Promise<{
    bookingId: number;
    tickets: Array<{ ticket_uuid: string; attendee_name: string; attendee_phone: string; signature: string }>;
    paymentRequired: boolean;
    paymentOrderId?: string;
    paymentSessionId?: string;
    zoneId: number;
    zonePricePaise: number;
    zoneName: string;
  }> {
    const ticketCount = attendees.length;

    // ── Rule: at least 1 ticket ───────────────────────────────────────────────
    if (ticketCount < 1) {
      throw new AppError('At least 1 ticket required', 400);
    }

    // ── Rule: max tickets per booking ────────────────────────────────────────
    const maxPerBooking = config.bookings.maxTicketsPerBooking;
    if (ticketCount > maxPerBooking) {
      throw new AppError(
        `You can book at most ${maxPerBooking} tickets at once`,
        400
      );
    }

    // ── Rule: per-user-per-event cap ─────────────────────────────────────────
    const maxPerUser = config.bookings.maxTicketsPerUserPerEvent;
    const existingCount = await bookingRepository.getUserBookedCount(userId, eventId);
    if (existingCount + ticketCount > maxPerUser) {
      throw new AppError(
        `Booking limit reached. You already have ${existingCount} ticket(s) for this event. Limit is ${maxPerUser} per user.`,
        403
      );
    }

    // ── Event existence + zone validation ────────────────────────────────────
    const event = await eventRepository.getEventById(eventId);
    if (!event) {
      throw new AppError('Event not found', 404);
    }
    if (event.status !== 'published') {
      throw new AppError('This event is not open for booking', 400);
    }
    // Free events must not be booked with zones
    if (event.is_free) {
      throw new AppError('Free events do not support zone-based booking', 400);
    }

    // Validate zone (active-only lookup — enforces deleted_at IS NULL AND is_active = true)
    const zone = await eventZoneRepository.getActiveZoneById(zoneId);
    if (!zone) {
      throw new AppError('Zone not found', 404);
    }
    if (zone.event_id !== eventId) {
      throw new AppError('Zone does not belong to this event', 400);
    }

    // ── Atomic zone capacity + event capacity reservation ────────────────────
    const zonePricePaise = Math.round(Number(zone.price) * 100);

    const result = await withTransaction(async (client) => {
      // 1. Lock and decrement zone capacity
      const newZoneRemaining = await eventZoneRepository.decrementZoneCapacity(zoneId, ticketCount);
      if (newZoneRemaining < 0) {
        throw new AppError(`Not enough tickets available in "${zone.name}" — only ${zone.remaining_capacity} left.`, 409);
      }

      // 2. Lock and decrement global event capacity
      const newEventRemaining = await bookingRepository.reserveCapacity(client, eventId, ticketCount);
      if (newEventRemaining < 0) {
        throw new AppError('Not enough tickets available for this event — please try again.', 409);
      }

      // 3. Insert booking row — always 'payment_pending' for zone-based paid events
      const bookingId = await bookingRepository.createBooking(client, userId, eventId, ticketCount, 'payment_pending');

      // 4. Generate ticket UUIDs
      const ticketUuids = attendees.map((_, idx) =>
        UniversalTicketService.generateTicketUuid('event')
      );

      // 5. Insert tickets
      const insertedTickets = await bookingRepository.createTicketsWithUuids(
        client, bookingId, attendees, ticketUuids
      );

      // 6. Sign tickets
      const signedTickets = insertedTickets.map(t => ({
        ...t,
        signature: UniversalTicketService.sign({
          domain: 'event',
          ticketUuid: t.ticket_uuid,
          entityId: eventId,
          startAt: event.start_at,
        }),
      }));

      for (const t of signedTickets) {
        await client.query(
          'UPDATE tickets SET signature = $1 WHERE id = $2',
          [t.signature, t.id]
        );
      }

      // 7. Record booking_zone join
      await eventZoneRepository.createBookingZone(
        bookingId,
        zoneId,
        ticketCount,
        zonePricePaise
      );

      return {
        bookingId,
        tickets: signedTickets,
        zonePricePaise,
        zoneName: zone.name,
      };
    });

    // Audit log
    bookingRepository.writeBookingAudit(
      result.bookingId, null, 'user', userId,
      'booking_created_zone_pending',
      { eventId, ticketCount, eventTitle: event.title, zoneId, zoneName: result.zoneName, zonePricePaise }
    ).catch((err) => {
      logger.warn('Booking audit log write failed', {
        bookingId: result.bookingId,
        action: 'booking_created_zone_pending',
        actor: 'user',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      bookingId: result.bookingId,
      tickets: result.tickets.map(t => ({
        ticket_uuid: t.ticket_uuid,
        attendee_name: t.attendee_name,
        attendee_phone: t.attendee_phone,
        signature: t.signature,
      })),
      paymentRequired: true,
      paymentOrderId: opts?.paymentOrderId,
      paymentSessionId: opts?.paymentSessionId,
      zoneId,
      zonePricePaise: result.zonePricePaise,
      zoneName: result.zoneName,
    };
  }

  /**
   * Confirm a booking after successful payment verification.
   * Transitions booking from 'payment_pending' → 'confirmed'.
   * Tickets are already signed — they just become fully valid.
   */
  async confirmBooking(bookingId: number): Promise<{ confirmed: boolean; tickets: Array<{ ticket_uuid: string; signature: string }> }> {
    const result = await withTransaction(async (client) => {
      // Lock the booking row
      const bookingResult = await client.query(
        'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
        [bookingId]
      );
      const booking = bookingResult.rows[0] as BookingRow | undefined;
      if (!booking) {
        throw new AppError('Booking not found', 404);
      }

      // Idempotent: if already confirmed, return immediately
      if (booking.status === 'confirmed') {
        const tickets = await client.query(
          'SELECT ticket_uuid, signature FROM tickets WHERE booking_id = $1',
          [bookingId]
        );
        return { confirmed: true, tickets: tickets.rows, alreadyConfirmed: true };
      }

      // Only confirm from payment_pending state
      if (booking.status !== 'payment_pending') {
        throw new AppError(`Booking is in status: ${booking.status}. Cannot confirm.`, 400);
      }

      // Update booking status
      await client.query(
        "UPDATE bookings SET status = 'confirmed', updated_at = NOW() WHERE id = $1",
        [bookingId]
      );

      // Fetch tickets with signatures
      const tickets = await client.query(
        'SELECT ticket_uuid, signature FROM tickets WHERE booking_id = $1',
        [bookingId]
      );

      return { confirmed: true, tickets: tickets.rows, alreadyConfirmed: false };
    });

    return result;
  }

  /**
   * Cancel a confirmed booking:
   *   1. Lock the booking row (FOR UPDATE)
   *   2. Verify the booking is in a cancellable state
   *   3. Check the event's cancellation window
   *   4. Mark booking cancelled
   *   5. Release capacity back to the event
   */
  async cancelBooking(bookingId: number, userId: number | undefined, reason: string | undefined) {
    // Verify the booking exists; userId is optional (for webhook-initiated cancellations)
    const existing = await bookingRepository.getBookingWithTickets(bookingId, userId);
    if (!existing) {
      throw new AppError('Booking not found', 404);
    }

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

    // For layout-based bookings, get zone info BEFORE the atomic cancel
    // so we can restore zone capacity in the same transaction.
    let layoutZoneId: number | undefined;
    let layoutZoneTicketCount: number | undefined;
    if (!event?.is_free) {
      try {
        const bookingZone = await eventZoneRepository.getBookingZone(bookingId);
        if (bookingZone) {
          layoutZoneId = bookingZone.zone_id;
          layoutZoneTicketCount = bookingZone.ticket_count;
        }
      } catch {
        // zone lookup failed — will fall through to non-layout cancellation path
      }
    }

    // Atomic cancel + capacity release (event + zone in the same transaction)
    const result = await bookingRepository.cancelBooking(
      bookingId,
      userId ?? 0,
      reason ?? null,
      layoutZoneId,
      layoutZoneTicketCount,
    );

    if (!result.cancelled) {
      throw new AppError('Failed to cancel booking', 500);
    }

    // Zone capacity is released inside the atomic bookingRepository.cancelBooking()
    // transaction. No additional release needed here.

    // Audit log
    bookingRepository.writeBookingAudit(
      bookingId, null, 'system', userId ?? 0,
      'booking_cancelled',
      { ticketCount: result.ticketCount, eventId: result.eventId, reason, zoneReleased: !!result }
    ).catch((err) => {
      logger.warn('Booking audit log write failed', {
        bookingId,
        action: 'booking_cancelled',
        actor: 'system',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      cancelled: true,
      bookingId,
      ticketCount: result.ticketCount,
      refundEligible: event?.cancellable_until ? new Date() <= new Date(event.cancellable_until) : true,
      isFreeEvent: event?.is_free ?? false,
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
        `SELECT b.*, e.title AS event_title, e.venue AS event_venue, e.start_at AS event_start_at,
                e.is_free AS event_is_free, e.price AS event_price,
                bz.zone_id, bz.ticket_count AS zone_ticket_count, bz.unit_price_paise AS zone_unit_price_paise,
                ez.name AS zone_name
           FROM bookings b
           INNER JOIN events e ON b.event_id = e.id
           LEFT JOIN booking_zones bz ON bz.booking_id = b.id
           LEFT JOIN event_zones ez ON ez.id = bz.zone_id
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
      event_is_free: boolean;
      event_price: number | string;
      zone_id: number | null;
      zone_name: string | null;
      zone_ticket_count: number | null;
      zone_unit_price_paise: number | null;
    }>;
  }
}

export const bookingService = new BookingService();
