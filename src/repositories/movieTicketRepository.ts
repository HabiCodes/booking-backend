/**
 * MovieTicketRepository — generates, signs, and validates movie tickets.
 * Tickets carry an HMAC-SHA256 signature and a UUID for verification.
 */

import { getPool } from '../db/pool';
import type { MovieTicketRow, MovieTicketPublic, MovieTicketWithDetails, MovieTicketStatus, MovieSeatType, ShowtimeFormat } from '../types';

export class MovieTicketRepository {
  async findById(id: number): Promise<MovieTicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_tickets WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as MovieTicketRow[])[0] || null;
  }

  async findByUuid(uuid: string): Promise<MovieTicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_tickets WHERE ticket_uuid = $1 LIMIT 1',
      [uuid]
    );
    return (rows as unknown as MovieTicketRow[])[0] || null;
  }

  async findByBooking(bookingId: number): Promise<MovieTicketRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_tickets WHERE booking_id = $1 ORDER BY row_label, seat_number',
      [bookingId]
    );
    return rows as unknown as MovieTicketRow[];
  }

  async findByShowtime(showtimeId: number): Promise<MovieTicketRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_tickets WHERE showtime_id = $1 ORDER BY row_label, seat_number',
      [showtimeId]
    );
    return rows as unknown as MovieTicketRow[];
  }

  async findByReference(reference: string): Promise<MovieTicketRow[]> {
    const { rows } = await getPool().query(
      `SELECT mt.* FROM movie_tickets mt
       JOIN movie_bookings mb ON mb.id = mt.booking_id
       WHERE mb.booking_reference = $1 AND mb.deleted_at IS NULL`,
      [reference]
    );
    return rows as unknown as MovieTicketRow[];
  }

  async create(input: {
    booking_id: number;
    booking_item_id: number;
    ticket_uuid: string;
    showtime_id: number;
    seat_label: string;
    row_label: string;
    seat_number: number;
    seat_type: string;
    qr_data: string;
    signature: string;
    status?: string;
    metadata?: Record<string, unknown>;
  }): Promise<MovieTicketRow> {
    const { rows } = await getPool().query(
      `INSERT INTO movie_tickets (booking_id, booking_item_id, ticket_uuid, showtime_id, seat_label, row_label, seat_number, seat_type, qr_data, signature, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.booking_id, input.booking_item_id, input.ticket_uuid,
        input.showtime_id, input.seat_label, input.row_label, input.seat_number,
        input.seat_type, input.qr_data, input.signature,
        input.status || 'valid',
        input.metadata || '{}',
      ]
    );
    return rows[0] as unknown as MovieTicketRow;
  }

  async bulkCreate(
    tickets: Array<{
      booking_id: number;
      booking_item_id: number;
      ticket_uuid: string;
      showtime_id: number;
      seat_label: string;
      row_label: string;
      seat_number: number;
      seat_type: string;
      qr_data: string;
      signature: string;
      status?: string;
      metadata?: Record<string, unknown>;
    }>,
    client?: import('pg').PoolClient
  ): Promise<MovieTicketRow[]> {
    if (tickets.length === 0) return [];
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const t of tickets) {
      values.push(`($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`);
      params.push(
        t.booking_id, t.booking_item_id, t.ticket_uuid, t.showtime_id,
        t.seat_label, t.row_label, t.seat_number, t.seat_type,
        t.qr_data, t.signature, t.status || 'valid', t.metadata || '{}'
      );
    }
    const pool = client || getPool();
    const { rows } = await pool.query(
      `INSERT INTO movie_tickets (booking_id, booking_item_id, ticket_uuid, showtime_id, seat_label, row_label, seat_number, seat_type, qr_data, signature, status, metadata)
       VALUES ${values.join(', ')} RETURNING *`,
      params
    );
    return rows as unknown as MovieTicketRow[];
  }

  async updateStatus(id: number, status: string): Promise<MovieTicketRow | null> {
    const { rows } = await getPool().query(
      'UPDATE movie_tickets SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );
    return (rows as unknown as MovieTicketRow[])[0] || null;
  }

  async markUsed(id: number, usedBy: number): Promise<MovieTicketRow | null> {
    const { rows } = await getPool().query(
      'UPDATE movie_tickets SET status = $1, used_at = NOW(), used_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *',
      ['used', usedBy, id]
    );
    return (rows as unknown as MovieTicketRow[])[0] || null;
  }

  async revoke(id: number, revokedBy: number, reason: string): Promise<MovieTicketRow | null> {
    const { rows } = await getPool().query(
      'UPDATE movie_tickets SET status = $1, revoked_at = NOW(), revoked_by = $2, revoked_reason = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      ['revoked', revokedBy, reason, id]
    );
    return (rows as unknown as MovieTicketRow[])[0] || null;
  }

  async findActiveByShowtime(showtimeId: number): Promise<MovieTicketRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_tickets WHERE showtime_id = $1 AND status = $2',
      [showtimeId, 'valid']
    );
    return rows as unknown as MovieTicketRow[];
  }

  async getTicketWithDetails(ticketUuid: string): Promise<MovieTicketWithDetails | null> {
    const { rows } = await getPool().query(
      `SELECT
        mt.*,
        mb.booking_reference,
        mb.status as booking_status,
        m.title as movie_title, m.poster_url as movie_poster,
        c.name as cinema_name, c.address as cinema_address, c.city as cinema_city,
        cs.screen_number, cs.name as screen_name,
        st.show_datetime, st.end_datetime, st.format, st.language as show_language
       FROM movie_tickets mt
       JOIN movie_bookings mb ON mb.id = mt.booking_id
       JOIN movies m ON m.id = mb.movie_id
       JOIN cinemas c ON c.id = mb.cinema_id
       JOIN cinema_screens cs ON cs.id = mb.cinema_screen_id
       JOIN showtimes st ON st.id = mt.showtime_id
       WHERE mt.ticket_uuid = $1 AND mb.deleted_at IS NULL
       LIMIT 1`,
      [ticketUuid]
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      id: r.id as number,
      bookingId: r.booking_id as number,
      bookingItemId: r.booking_item_id as number,
      ticketUuid: r.ticket_uuid as string,
      showtimeId: r.showtime_id as number,
      seatLabel: r.seat_label as string,
      rowLabel: r.row_label as string,
      seatNumber: r.seat_number as number,
      seatType: r.seat_type as MovieSeatType,
      qrData: r.qr_data as string,
      signature: r.signature as string,
      status: r.status as MovieTicketStatus,
      usedAt: r.used_at as string | null,
      revokedAt: r.revoked_at as string | null,
      createdAt: r.created_at as string,
      movieTitle: r.movie_title as string,
      cinemaName: r.cinema_name as string,
      cinemaCity: r.cinema_city as string,
      screenName: r.screen_name as string | null,
      showtimeDatetime: r.show_datetime as string,
      showtimeFormat: r.format as ShowtimeFormat,
      showtimeLanguage: r.show_language as string,
    } as unknown as MovieTicketWithDetails;
  }
}

export const movieTicketRepository = new MovieTicketRepository();
