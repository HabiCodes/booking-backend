/**
 * MovieBookingAuditRepository — append-only audit trail for movie bookings.
 * Records every state change, action, and actor for compliance and debugging.
 */

import { getPool } from '../db/pool';

interface MovieBookingAuditRow {
  id: number;
  booking_id: number | null;
  ticket_id: number | null;
  actor_type: string;
  actor_id: number | null;
  action: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class MovieBookingAuditRepository {
  async create(input: {
    bookingId: number;
    ticketId?: number | null;
    actorType: string;
    actorId?: number | null;
    action: string;
    metadata?: Record<string, unknown>;
  }): Promise<MovieBookingAuditRow> {
    const { rows } = await getPool().query(
      `INSERT INTO movie_booking_audits (booking_id, ticket_id, actor_type, actor_id, action, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [input.bookingId, input.ticketId || null, input.actorType, input.actorId || null, input.action, input.metadata || '{}']
    );
    return rows[0] as unknown as MovieBookingAuditRow;
  }

  async findByBooking(bookingId: number): Promise<MovieBookingAuditRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_booking_audits WHERE booking_id = $1 ORDER BY created_at DESC',
      [bookingId]
    );
    return rows as unknown as MovieBookingAuditRow[];
  }

  async findByTicket(ticketId: number): Promise<MovieBookingAuditRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_booking_audits WHERE ticket_id = $1 ORDER BY created_at DESC',
      [ticketId]
    );
    return rows as unknown as MovieBookingAuditRow[];
  }

  async countByBooking(bookingId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as total FROM movie_booking_audits WHERE booking_id = $1',
      [bookingId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }
}

export const movieBookingAuditRepository = new MovieBookingAuditRepository();
