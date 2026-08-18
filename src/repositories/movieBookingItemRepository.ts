/**
 * MovieBookingItemRepository — individual seat entries for a movie booking.
 * Enforces seat+showtime uniqueness for active bookings via application logic.
 */

import { getPool } from '../db/pool';
import type { MovieBookingItemRow, MovieBookingItemPublic } from '../types';

export class MovieBookingItemRepository {
  async findByBooking(bookingId: number): Promise<MovieBookingItemRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_booking_items WHERE booking_id = $1 ORDER BY row_label, seat_number',
      [bookingId]
    );
    return rows as unknown as MovieBookingItemRow[];
  }

  async findByShowtime(showtimeId: number): Promise<MovieBookingItemRow[]> {
    const { rows } = await getPool().query(
      `SELECT mbi.* FROM movie_booking_items mbi
       JOIN movie_bookings mb ON mb.id = mbi.booking_id
       WHERE mbi.showtime_id = $1 AND mb.status IN ('pending_payment', 'confirmed') AND mb.deleted_at IS NULL`,
      [showtimeId]
    );
    return rows as unknown as MovieBookingItemRow[];
  }

  async findBySeatAndShowtime(seatId: number, showtimeId: number): Promise<MovieBookingItemRow | null> {
    const { rows } = await getPool().query(
      `SELECT mbi.* FROM movie_booking_items mbi
       JOIN movie_bookings mb ON mb.id = mbi.booking_id
       WHERE mbi.seat_id = $1 AND mbi.showtime_id = $2
         AND mb.status IN ('pending_payment', 'confirmed') AND mb.deleted_at IS NULL
       LIMIT 1`,
      [seatId, showtimeId]
    );
    return (rows as unknown as MovieBookingItemRow[])[0] || null;
  }

  async bulkCreate(
    items: Array<{
      booking_id: number;
      showtime_id: number;
      seat_id: number;
      seat_label: string;
      row_label: string;
      seat_number: number;
      seat_type: string;
      seat_category: string;
      price: number;
      currency: string;
    }>
  ): Promise<MovieBookingItemRow[]> {
    if (items.length === 0) return [];
    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const item of items) {
      values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
      params.push(
        item.booking_id, item.showtime_id, item.seat_id, item.seat_label,
        item.row_label, item.seat_number, item.seat_type, item.seat_category,
        item.price, item.currency
      );
    }
    const { rows } = await getPool().query(
      `INSERT INTO movie_booking_items (booking_id, showtime_id, seat_id, seat_label, row_label, seat_number, seat_type, seat_category, price, currency)
       VALUES ${values.join(', ')} RETURNING *`,
      params
    );
    return rows as unknown as MovieBookingItemRow[];
  }

  async deleteByBooking(bookingId: number): Promise<void> {
    await getPool().query('DELETE FROM movie_booking_items WHERE booking_id = $1', [bookingId]);
  }

  async deleteByBookingId(bookingId: number): Promise<void> {
    await this.deleteByBooking(bookingId);
  }
}

export const movieBookingItemRepository = new MovieBookingItemRepository();
