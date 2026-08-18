/**
 * CinemaSeatRepository — manages physical seats within a screen, including
 * bulk creation from a template and availability lookups.
 */

import { getPool } from '../db/pool';
import type { CinemaSeatRow, CinemaSeatCreateInput, CinemaSeatPublic } from '../types';

export class CinemaSeatRepository {
  async findByScreen(screenId: number): Promise<CinemaSeatRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinema_seats WHERE screen_id = $1 AND is_available = true ORDER BY row_label, seat_number',
      [screenId]
    );
    return rows as unknown as CinemaSeatRow[];
  }

  async findAvailableByScreen(screenId: number): Promise<CinemaSeatRow[]> {
    return this.findByScreen(screenId);
  }

  async findByIds(ids: number[]): Promise<CinemaSeatRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await getPool().query(
      'SELECT * FROM cinema_seats WHERE id = ANY($1::int[])',
      [ids]
    );
    return rows as unknown as CinemaSeatRow[];
  }

  async findByShowtime(showtimeId: number): Promise<
    Array<{ seat: CinemaSeatRow; status: 'available' | 'held' | 'booked'; holdExpiresAt: string | null }>
  > {
    const { rows } = await getPool().query(
      `SELECT
        cs.*,
        CASE
          WHEN EXISTS (SELECT 1 FROM movie_booking_items mbi
            JOIN movie_bookings mb ON mb.id = mbi.booking_id
            WHERE mbi.seat_id = cs.id AND mbi.showtime_id = $1
              AND mb.status IN ('pending_payment', 'confirmed') AND mb.deleted_at IS NULL)
            THEN 'booked'
          ELSE 'available'
        END as status,
        (SELECT mb.hold_expires_at FROM movie_booking_items mbi
         JOIN movie_bookings mb ON mb.id = mbi.booking_id
         WHERE mbi.seat_id = cs.id AND mbi.showtime_id = $1
           AND mb.status = 'pending_payment' AND mb.deleted_at IS NULL
         LIMIT 1) as hold_expires_at
       FROM cinema_seats cs
       WHERE cs.screen_id = (SELECT screen_id FROM showtimes WHERE id = $1)
       ORDER BY cs.row_label, cs.seat_number`,
      [showtimeId]
    );
    return rows.map((r: Record<string, unknown>) => ({
      seat: r as unknown as CinemaSeatRow,
      status: r.status as 'available' | 'held' | 'booked',
      holdExpiresAt: r.hold_expires_at as string | null,
    }));
  }

  async bulkCreate(screenId: number, seats: CinemaSeatCreateInput[]): Promise<CinemaSeatRow[]> {
    const results: CinemaSeatRow[] = [];
    for (const seat of seats) {
      const { rows } = await getPool().query(
        `INSERT INTO cinema_seats (screen_id, row_label, seat_number, seat_type, seat_category, x_position, y_position, is_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         RETURNING *`,
        [screenId, seat.rowLabel, seat.seatNumber, seat.seatType || 'standard', seat.seatCategory || 'regular', seat.xPosition ?? null, seat.yPosition ?? null]
      );
      results.push(rows[0] as unknown as CinemaSeatRow);
    }
    return results;
  }

  async bulkUpdateAvailability(seatIds: number[], available: boolean): Promise<void> {
    if (seatIds.length === 0) return;
    await getPool().query(
      'UPDATE cinema_seats SET is_available = $1, updated_at = NOW() WHERE id = ANY($2::int[])',
      [available, seatIds]
    );
  }

  async softDeleteByScreen(screenId: number): Promise<void> {
    await getPool().query(
      'UPDATE cinema_seats SET is_available = false, updated_at = NOW() WHERE screen_id = $1',
      [screenId]
    );
  }

  async getSeatCount(screenId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as total FROM cinema_seats WHERE screen_id = $1 AND is_available = true',
      [screenId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }
}

export const cinemaSeatRepository = new CinemaSeatRepository();
