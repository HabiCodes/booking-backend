/**
 * Seat repository — individual seat management for reserved seating events.
 */

import { getPool } from '../db/pool';
import type { SeatRow, SeatPublic, SeatBulkCreateInput, SeatType } from '../types';

export class SeatRepository {
  async findById(id: number): Promise<SeatRow | null> {
    const { rows } = await getPool().query('SELECT * FROM seats WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as SeatRow[])[0] || null;
  }

  async findByEvent(eventId: number): Promise<SeatRow[]> {
    const { rows } = await getPool().query('SELECT * FROM seats WHERE event_id = $1 ORDER BY section, row_label, seat_number', [eventId]);
    return rows as unknown as SeatRow[];
  }

  async findAvailableByEvent(eventId: number): Promise<SeatRow[]> {
    const { rows } = await getPool().query('SELECT * FROM seats WHERE event_id = $1 AND is_available = true ORDER BY section, row_label, seat_number', [eventId]);
    return rows as unknown as SeatRow[];
  }

  async findByEventAndTier(eventId: number, tierId: number): Promise<SeatRow[]> {
    const { rows } = await getPool().query('SELECT * FROM seats WHERE event_id = $1 AND tier_id = $2 ORDER BY section, row_label, seat_number', [eventId, tierId]);
    return rows as unknown as SeatRow[];
  }

  async findBySection(eventId: number, section: string): Promise<SeatRow[]> {
    const { rows } = await getPool().query('SELECT * FROM seats WHERE event_id = $1 AND section = $2 ORDER BY row_label, seat_number', [eventId, section]);
    return rows as unknown as SeatRow[];
  }

  async bulkCreate(eventId: number, bulk: SeatBulkCreateInput, tierId?: number | null): Promise<SeatRow[]> {
    const seats: SeatRow[] = [];
    for (const rowGroup of bulk.rows) {
      for (const seatNum of rowGroup.seat_numbers) {
        const { rows } = await getPool().query(
          `INSERT INTO seats (event_id, tier_id, section, row_label, seat_number, seat_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [eventId, tierId ?? null, bulk.section, rowGroup.row_label, seatNum, rowGroup.seat_type || 'standard']
        );
        seats.push(...(rows as unknown as SeatRow[]));
      }
    }
    return seats;
  }

  async markAvailable(ids: number[], available: boolean): Promise<void> {
    await getPool().query('UPDATE seats SET is_available = $1 WHERE id = ANY($2::int[])', [available, ids]);
  }

  async holdSeats(seatIds: number[], bookingId: number, expiresMinutes: number): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresMinutes * 60_000).toISOString();
    await getPool().query('UPDATE seats SET is_held = true, hold_expires_at = $1, hold_booking_id = $2 WHERE id = ANY($3::int[])', [expiresAt, bookingId, seatIds]);
  }

  async releaseHold(bookingId: number): Promise<void> {
    await getPool().query('UPDATE seats SET is_held = false, hold_expires_at = NULL, hold_booking_id = NULL WHERE hold_booking_id = $1', [bookingId]);
  }

  async reserveSeats(seatIds: number[]): Promise<void> {
    await getPool().query('UPDATE seats SET is_reserved = true, is_available = false, is_held = false WHERE id = ANY($1::int[])', [seatIds]);
  }

  async clearExpiredHolds(): Promise<number> {
    const { rows } = await getPool().query(`UPDATE seats SET is_held = false, hold_expires_at = NULL, hold_booking_id = NULL WHERE is_held = true AND hold_expires_at < NOW() RETURNING id`);
    return (rows as Array<{ id: number }>).length;
  }

  async deleteByEvent(eventId: number): Promise<void> {
    await getPool().query('DELETE FROM seats WHERE event_id = $1', [eventId]);
  }
}

export const seatRepository = new SeatRepository();
