import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { BookingRow, TicketRow, CreateBookingInput } from '../types';
import { v4 as uuidv4 } from 'uuid';

type QueryExecutor = Pool | PoolClient;

export class BookingRepository {
  async createBooking(
    exec: QueryExecutor,
    userId: number,
    eventId: number,
    ticketCount: number
  ): Promise<number> {
    const { rows } = await exec.query(
      'INSERT INTO bookings (user_id, event_id, ticket_count) VALUES ($1, $2, $3) RETURNING id',
      [userId, eventId, ticketCount]
    );
    const row = rows as Array<{ id: number }>;
    return row[0]?.id ?? 0;
  }

  async createTickets(
    exec: QueryExecutor,
    bookingId: number,
    attendees: CreateBookingInput['attendees']
  ): Promise<void> {
    if (attendees.length === 0) return;

    const values: string[] = [];
    const params: unknown[] = [];
    for (const att of attendees) {
      const offset = params.length;
      values.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
      );
      params.push(
        bookingId,
        uuidv4(),
        att.full_name.trim(),
        att.phone.trim(),
        att.age !== undefined && att.age !== null && att.age !== ''
          ? parseInt(String(att.age), 10)
          : null,
        att.gender?.toLowerCase().trim() || null
      );
    }

    const text = `INSERT INTO tickets
      (booking_id, ticket_uuid, attendee_name, attendee_phone, attendee_age, attendee_gender)
      VALUES ${values.join(', ')}`;

    await exec.query(text, params);
  }

  async getBookingWithTickets(
    bookingId: number,
    userId: number
  ): Promise<{ booking: BookingRow; tickets: TicketRow[] } | null> {
    const bookingRes = await getPool().query(
      'SELECT * FROM bookings WHERE id = $1 AND user_id = $2 LIMIT 1',
      [bookingId, userId]
    );
    const booking = (bookingRes.rows as unknown as BookingRow[])[0];
    if (!booking) return null;

    const ticketRes = await getPool().query(
      'SELECT * FROM tickets WHERE booking_id = $1',
      [bookingId]
    );
    return { booking, tickets: ticketRes.rows as unknown as TicketRow[] };
  }

  async getTicketsByUuid(ticketUuid: string): Promise<TicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM tickets WHERE ticket_uuid = $1 LIMIT 1',
      [ticketUuid]
    );
    return (rows as unknown as TicketRow[])[0] || null;
  }

  async markTicketCheckedIn(ticketUuid: string, adminId: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE tickets SET checked_in = true, checked_in_at = NOW(), checked_in_by = $1
       WHERE ticket_uuid = $2 AND checked_in = false`,
      [adminId, ticketUuid]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getAllBookings(
    limit: number,
    offset: number
  ): Promise<(BookingRow & { user_email: string })[]> {
    const { rows } = await getPool().query(
      `SELECT b.*, u.email AS user_email
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows as unknown as Array<BookingRow & { user_email: string }>;
  }
}

export const bookingRepository = new BookingRepository();
