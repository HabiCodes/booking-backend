/**
 * MovieBookingRepository — manages movie booking lifecycle. Uses FOR UPDATE
 * row-level locking in the service layer for concurrency safety on
 * seat allocation.
 */

import { getPool } from '../db/pool';
import type {
  MovieBookingRow,
  MovieBookingPublic,
  MovieBookingCreateInput,
  MovieBookingWithDetails,
  MovieBookingStatus,
  ShowtimeFormat,
  MovieRow,
  CinemaRow,
  CinemaScreenRow,
  ShowtimeRow,
} from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class MovieBookingRepository {
  async findById(id: number): Promise<MovieBookingRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_bookings WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as MovieBookingRow[])[0] || null;
  }

  async findByReference(reference: string): Promise<MovieBookingRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_bookings WHERE booking_reference = $1 AND deleted_at IS NULL LIMIT 1',
      [reference]
    );
    return (rows as unknown as MovieBookingRow[])[0] || null;
  }

  async findByUser(
    userId: number,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<MovieBookingRow>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query(
      'SELECT COUNT(*) as total FROM movie_bookings WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      'SELECT * FROM movie_bookings WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, pageSize, offset]
    );
    return { items: rows as unknown as MovieBookingRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findByShowtime(showtimeId: number): Promise<MovieBookingRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM movie_bookings WHERE showtime_id = $1 AND status IN ('pending_payment', 'confirmed') AND deleted_at IS NULL`,
      [showtimeId]
    );
    return rows as unknown as MovieBookingRow[];
  }

  async findByIdempotencyKey(key: string): Promise<MovieBookingRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_bookings WHERE idempotency_key = $1 AND deleted_at IS NULL LIMIT 1',
      [key]
    );
    return (rows as unknown as MovieBookingRow[])[0] || null;
  }

  async create(input: MovieBookingCreateInput): Promise<MovieBookingRow> {
    const bookingReference = `MOV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const { rows } = await getPool().query(
      `INSERT INTO movie_bookings (booking_reference, user_id, organization_id, movie_id, cinema_id, cinema_screen_id, showtime_id, amount, currency, seat_count, status, payment_status, idempotency_key, hold_expires_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        bookingReference,
        input.userId,
        input.organizationId ?? null,
        input.movieId,
        input.cinemaId,
        input.cinemaScreenId,
        input.showtimeId,
        input.amount,
        input.currency || 'INR',
        input.seatCount,
        input.status || 'pending_payment',
        input.paymentStatus || 'initiated',
        input.idempotencyKey || null,
        input.holdExpiresAt || new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        input.metadata || '{}',
      ]
    );
    return rows[0] as unknown as MovieBookingRow;
  }

  async updateStatus(id: number, status: MovieBookingStatus): Promise<MovieBookingRow | null> {
    const { rows } = await getPool().query(
      'UPDATE movie_bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, id]
    );
    return (rows as unknown as MovieBookingRow[])[0] || null;
  }

  async updatePaymentStatus(id: number, paymentStatus: string): Promise<MovieBookingRow | null> {
    const { rows } = await getPool().query(
      'UPDATE movie_bookings SET payment_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [paymentStatus, id]
    );
    return (rows as unknown as MovieBookingRow[])[0] || null;
  }

  async updateHoldExpires(id: number, expiresAt: string): Promise<void> {
    await getPool().query(
      'UPDATE movie_bookings SET hold_expires_at = $1, updated_at = NOW() WHERE id = $2',
      [expiresAt, id]
    );
  }

  async cancelExpiredHolds(cutoff: string): Promise<MovieBookingRow[]> {
    const { rows } = await getPool().query(
      `UPDATE movie_bookings SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending_payment' AND hold_expires_at <= $1 AND deleted_at IS NULL
       RETURNING *`,
      [cutoff]
    );
    return rows as unknown as MovieBookingRow[];
  }

  async getBookingWithDetails(bookingId: number): Promise<MovieBookingWithDetails | null> {
    const { rows } = await getPool().query(
      `SELECT
        mb.*,
        m.title as movie_title, m.poster_url as movie_poster, m.duration_minutes,
        c.name as cinema_name, c.address as cinema_address, c.city as cinema_city,
        cs.screen_number, cs.name as screen_name, cs.screen_type,
        st.show_datetime, st.end_datetime, st.format, st.language as show_language
       FROM movie_bookings mb
       JOIN movies m ON m.id = mb.movie_id
       JOIN cinemas c ON c.id = mb.cinema_id
       JOIN cinema_screens cs ON cs.id = mb.cinema_screen_id
       JOIN showtimes st ON st.id = mb.showtime_id
       WHERE mb.id = $1 AND mb.deleted_at IS NULL
       LIMIT 1`,
      [bookingId]
    );
    if (rows.length === 0) return null;
    const r = rows[0] as Record<string, unknown>;
    return {
      booking: r as unknown as MovieBookingRow,
      movie: r as unknown as MovieRow,
      cinema: r as unknown as CinemaRow,
      screen: r as unknown as CinemaScreenRow,
      showtime: r as unknown as ShowtimeRow,
      items: [],
    };
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE movie_bookings SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const movieBookingRepository = new MovieBookingRepository();
