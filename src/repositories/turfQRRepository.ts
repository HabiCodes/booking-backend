/**
 * Turf QR ticket repository.
 */

import { getPool } from '../db/pool';
import type { TurfQRTicketRow, TurfQRTicketPublic } from '../types';

export class TurfQRRepository {
  async create(bookingId: number, token: string): Promise<TurfQRTicketRow> {
    const { rows } = await getPool().query(
      'INSERT INTO turf_qr_tickets (booking_id, token) VALUES ($1, $2) RETURNING *',
      [bookingId, token]
    );
    return rows[0] as TurfQRTicketRow;
  }

  async findByToken(token: string): Promise<TurfQRTicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_qr_tickets WHERE token = $1 LIMIT 1',
      [token]
    );
    return (rows as TurfQRTicketRow[])[0] || null;
  }

  async findByBooking(bookingId: number): Promise<TurfQRTicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_qr_tickets WHERE booking_id = $1 LIMIT 1',
      [bookingId]
    );
    return (rows as TurfQRTicketRow[])[0] || null;
  }

  async markUsed(id: number, usedBy: number): Promise<void> {
    await getPool().query(
      "UPDATE turf_qr_tickets SET status = 'used', used_at = NOW(), used_by = $2 WHERE id = $1 AND status = 'issued'",
      [id, usedBy]
    );
  }

  async revokeByBooking(bookingId: number): Promise<void> {
    await getPool().query(
      "UPDATE turf_qr_tickets SET status = 'revoked' WHERE booking_id = $1 AND status = 'issued'",
      [bookingId]
    );
  }
}

export const turfQRRepository = new TurfQRRepository();
