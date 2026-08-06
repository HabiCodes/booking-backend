"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingService = exports.BookingService = void 0;
const pool_1 = require("../db/pool");
const eventRepository_1 = require("../repositories/eventRepository");
const bookingRepository_1 = require("../repositories/bookingRepository");
const errorHandler_1 = require("../middleware/errorHandler");
const config_1 = require("../config");
class BookingService {
    /**
     * Create a booking atomically:
     *   1. Lock the event row (FOR UPDATE)
     *   2. Reserve capacity from `events.remaining_capacity`
     *   3. Insert the booking row
     *   4. Insert individual tickets (one at a time with immediate RETURNING)
     *   5. Commit → all-or-nothing
     */
    async createBooking(userId, eventId, attendees) {
        const ticketCount = attendees.length;
        // ── Rule: at least 1 ticket ───────────────────────────────────────────────
        if (ticketCount < 1)
            throw new errorHandler_1.AppError('At least 1 ticket required', 400);
        // ── Rule: max tickets per booking ────────────────────────────────────────
        const maxPerBooking = config_1.config.bookings.maxTicketsPerBooking;
        if (ticketCount > maxPerBooking) {
            throw new errorHandler_1.AppError(`You can book at most ${maxPerBooking} tickets at once`, 400);
        }
        // ── Event existence ──────────────────────────────────────────────────────
        const event = await eventRepository_1.eventRepository.getEventById(eventId);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        if (event.status !== 'published')
            throw new errorHandler_1.AppError('This event is not open for booking', 400);
        // ── Rule: per-user-per-event cap ─────────────────────────────────────────
        const maxPerUser = config_1.config.bookings.maxTicketsPerUserPerEvent;
        const existingCount = await bookingRepository_1.bookingRepository.getUserBookedCount(userId, eventId);
        if (existingCount + ticketCount > maxPerUser) {
            throw new errorHandler_1.AppError(`Booking limit reached. You already have ${existingCount} ticket(s) for this event. Limit is ${maxPerUser} per user.`, 403);
        }
        // ── Rule: cancellation window check ──────────────────────────────────────
        if (event.cancellable_until && new Date() > new Date(event.cancellable_until)) {
            throw new errorHandler_1.AppError('This event has passed its cancellation window and cannot be booked with refund.', 400);
        }
        // ── Atomic booking + capacity reservation ────────────────────────────────
        const { booking, tickets } = await (0, pool_1.withTransaction)(async (client) => {
            // Lock event row and atomically reserve capacity
            const newRemaining = await bookingRepository_1.bookingRepository.reserveCapacity(client, eventId, ticketCount);
            if (newRemaining < 0) {
                throw new errorHandler_1.AppError('Not enough tickets available — please try again.', 409);
            }
            // Insert booking row
            const bookingId = await bookingRepository_1.bookingRepository.createBooking(client, userId, eventId, ticketCount);
            // Insert tickets (one-at-a-time with RETURNING)
            const insertedTickets = await bookingRepository_1.bookingRepository.createTickets(client, bookingId, attendees);
            // Sign each ticket with HMAC
            await bookingRepository_1.bookingRepository.signTickets(insertedTickets, eventId, event.start_at, client);
            return {
                booking: {
                    id: bookingId,
                    user_id: userId,
                    event_id: eventId,
                    ticket_count: ticketCount,
                    status: 'pending',
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
        bookingRepository_1.bookingRepository.writeBookingAudit(booking.id, null, 'user', userId, 'booking_created', { eventId, ticketCount, eventTitle: event.title }).catch(() => { });
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
    async cancelBooking(bookingId, userId, reason) {
        // Verify the booking exists and belongs to this user
        const existing = await bookingRepository_1.bookingRepository.getBookingWithTickets(bookingId, userId);
        if (!existing)
            throw new errorHandler_1.AppError('Booking not found', 404);
        if (existing.booking.status === 'cancelled') {
            throw new errorHandler_1.AppError('Booking is already cancelled', 400);
        }
        if (existing.booking.status === 'attended') {
            throw new errorHandler_1.AppError('Cannot cancel a booking that has already been attended', 400);
        }
        // Check cancellation window on the event
        const event = await eventRepository_1.eventRepository.getEventById(existing.booking.event_id);
        if (event?.cancellable_until && new Date() > new Date(event.cancellable_until)) {
            throw new errorHandler_1.AppError('This booking is past the cancellation window and cannot be cancelled for a refund.', 403);
        }
        // Atomic cancel + capacity release
        const result = await bookingRepository_1.bookingRepository.cancelBooking(bookingId, userId, reason ?? null);
        if (!result.cancelled) {
            throw new errorHandler_1.AppError('Failed to cancel booking', 500);
        }
        // Audit log
        bookingRepository_1.bookingRepository.writeBookingAudit(bookingId, null, 'user', userId, 'booking_cancelled', { ticketCount: result.ticketCount, eventId: result.eventId, reason }).catch(() => { });
        return {
            cancelled: true,
            bookingId,
            ticketCount: result.ticketCount,
            refundEligible: event?.cancellable_until ? new Date() <= new Date(event.cancellable_until) : true,
        };
    }
    async getBooking(bookingId, userId) {
        const booking = await bookingRepository_1.bookingRepository.getBookingWithTickets(bookingId, userId);
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        return booking;
    }
    async getMyBookings(userId) {
        const rows = await (0, pool_1.withTransaction)(async (client) => {
            const result = await client.query(`SELECT b.*, e.title AS event_title, e.venue AS event_venue, e.start_at AS event_start_at
         FROM bookings b
         INNER JOIN events e ON b.event_id = e.id
         WHERE b.user_id = $1
         ORDER BY b.created_at DESC`, [userId]);
            return result.rows;
        });
        return rows;
    }
}
exports.BookingService = BookingService;
exports.bookingService = new BookingService();
