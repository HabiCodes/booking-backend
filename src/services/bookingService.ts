import { v4 as uuidv4 } from 'uuid';
import { getPool, withTransaction } from '../db/pool';
import { eventRepository } from '../repositories/eventRepository';
import { userRepository } from '../repositories/userRepository';
import { bookingRepository } from '../repositories/bookingRepository';
import { AppError } from '../middleware/errorHandler';
import { type BookingRow, AttendeeInput } from '../types';

const MAX_TICKETS_PER_USER_VAL = 10;

export class BookingService {
  async createBooking(userId: number, eventId: number, attendees: AttendeeInput[]) {
    const ticketCount = attendees.length;

    if (ticketCount < 1) throw new AppError('At least 1 ticket required', 400);
    if (ticketCount > MAX_TICKETS_PER_USER_VAL) {
      throw new AppError(
        `You can book at most ${MAX_TICKETS_PER_USER_VAL} tickets at once`,
        400
      );
    }

    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);

    const existingCount = await userRepository.getUserTicketCount(userId, eventId);
    if (existingCount + ticketCount > MAX_TICKETS_PER_USER_VAL) {
      throw new AppError(
        `Maximum booking limit reached. You already have ${existingCount} ticket(s). Limit is ${MAX_TICKETS_PER_USER_VAL} per user.`,
        403
      );
    }

    const bookingId = await withTransaction(async (client) => {
      // Lock the event row and read capacity
      const capResult = await client.query(
        'SELECT capacity FROM events WHERE id = $1 FOR UPDATE',
        [eventId]
      );
      const capRow = capResult.rows[0];
      if (!capRow) throw new AppError('Event not found', 404);
      const capacity = Number(capRow.capacity);

      // Calculate current booked tickets
      const bookedResult = await client.query(
        'SELECT COALESCE(SUM(ticket_count), 0) AS total FROM bookings WHERE event_id = $1',
        [eventId]
      );
      const bookedRow = bookedResult.rows[0];
      const currentBooked = Number(bookedRow?.total ?? 0);

      if (currentBooked + ticketCount > capacity) {
        throw new AppError('Not enough tickets available', 409);
      }

      // Create booking row and get the generated ID
      const bookingId = await bookingRepository.createBooking(client, userId, eventId, ticketCount);

      // Create individual ticket rows
      await bookingRepository.createTickets(client, bookingId, attendees);

      return bookingId;
    });

    return bookingId;
  }

  async getBooking(bookingId: number, userId: number) {
    const booking = await bookingRepository.getBookingWithTickets(bookingId, userId);
    if (!booking) throw new AppError('Booking not found', 404);
    return booking;
  }

  async getMyBookings(userId: number) {
    const { rows } = await getPool().query(
      `SELECT b.*, e.title AS event_title, e.venue AS event_venue, e.start_at AS event_start_at
       FROM bookings b
       INNER JOIN events e ON b.event_id = e.id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [userId]
    );
    return rows as unknown as Array<BookingRow & {
      event_title: string;
      event_venue: string;
      event_start_at: Date;
    }>;
  }
}

export const bookingService = new BookingService();
