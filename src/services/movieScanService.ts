/**
 * MovieScanService — ticket verification for movie gate scanners.
 *
 * Reads from the movie_tickets table (not the event tickets table),
 * checks signature validity, showtime timing, and status.
 */

import { getPool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { verifyTicketSignature } from '../utils/qrCode';
import { config } from '../config';

export type MovieScanStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';

export interface MovieScanResult {
  status: MovieScanStatus;
  ticket?: {
    uuid: string;
    seatLabel: string;
    rowLabel: string;
    movieTitle: string;
    cinemaName: string;
    screenNumber: number;
    showtime: string;
    checkedIn: boolean;
    checkedInAt: string | null;
    signatureValid?: boolean;
  };
  message: string;
}

interface MovieTicketRow {
  ticket_uuid: string;
  status: string;
  used_at: string | null;
  revoked_at: string | null;
  signature: string | null;
  seat_label: string;
  row_label: string;
  showtime_id: number;
  movie_title: string;
  cinema_name: string;
  screen_number: number;
  show_datetime: string;
  end_datetime: string | null;
  deleted_at: string | null;
}

async function getMovieTicketWithDetails(uuid: string): Promise<MovieTicketRow | null> {
  const { rows } = await getPool().query(
    `SELECT
       mt.ticket_uuid, mt.status, mt.used_at, mt.revoked_at,
       mt.signature, mt.seat_label, mt.row_label, mt.showtime_id,
       m.title AS movie_title, c.name AS cinema_name, cs.screen_number,
       st.show_datetime, st.end_datetime
     FROM movie_tickets mt
     JOIN movie_bookings mb ON mb.id = mt.booking_id
     JOIN movies m ON m.id = mb.movie_id
     JOIN cinemas c ON c.id = mb.cinema_id
     JOIN cinema_screens cs ON cs.id = mb.cinema_screen_id
     JOIN showtimes st ON st.id = mt.showtime_id
     WHERE mt.ticket_uuid = $1 AND mb.deleted_at IS NULL
     LIMIT 1`,
    [uuid]
  );
  return (rows as MovieTicketRow[])[0] || null;
}

export class MovieScanService {
  async verify(uuid: string): Promise<MovieScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getMovieTicketWithDetails(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    // Revoked tickets are immediately invalid
    if (ticket.revoked_at) {
      return {
        status: 'INVALID',
        message: 'Ticket has been revoked',
        ticket: this._toTicketInfo(ticket, false),
      };
    }

    // EXPIRED: showtime end_datetime has passed
    if (ticket.end_datetime && new Date(ticket.end_datetime) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: this._toTicketInfo(ticket, false),
        message: 'Showtime has ended — ticket is no longer valid',
      };
    }

    // ALREADY_SCANNED: ticket already used
    if (ticket.status === 'used') {
      return {
        status: 'ALREADY_SCANNED',
        ticket: this._toTicketInfo(ticket, true),
        message: 'Ticket already scanned',
      };
    }

    // Verify HMAC signature
    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.showtime_id,
      '',
      ticket.signature
    );

    const signatureOk = sigResult.valid;

    return {
      status: signatureOk ? 'VALID' : 'INVALID',
      ticket: this._toTicketInfo(ticket, !!ticket.used_at, signatureOk),
      message: signatureOk ? 'Ticket is valid' : (sigResult.reason ?? 'Invalid signature'),
    };
  }

  async markCheckedIn(uuid: string, adminId: number): Promise<MovieScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getMovieTicketWithDetails(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    if (ticket.revoked_at) {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false),
        message: 'Ticket has been revoked',
      };
    }

    if (ticket.end_datetime && new Date(ticket.end_datetime) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: this._toTicketInfo(ticket, false),
        message: 'Showtime has ended — cannot check in',
      };
    }

    if (ticket.status === 'used') {
      return {
        status: 'ALREADY_SCANNED',
        ticket: this._toTicketInfo(ticket, true),
        message: 'Ticket was already scanned',
      };
    }

    // Mark as used atomically (only if still 'valid')
    const { rows } = await getPool().query(
      `UPDATE movie_tickets SET status = 'used', used_at = NOW(), used_by = $1, updated_at = NOW()
       WHERE ticket_uuid = $2 AND status = 'valid' RETURNING *`,
      [adminId, uuid]
    );

    if ((rows as any[]).length === 0) {
      // Already scanned by another scanner — reload
      const refreshed = await getMovieTicketWithDetails(uuid);
      return {
        status: 'ALREADY_SCANNED',
        ticket: refreshed ? this._toTicketInfo(refreshed, true) : undefined,
        message: 'Ticket was already scanned',
      };
    }

    return {
      status: 'VALID',
      ticket: this._toTicketInfo(ticket, true, true),
      message: 'Ticket checked in successfully',
    };
  }

  private _toTicketInfo(
    ticket: MovieTicketRow,
    checkedIn: boolean,
    signatureValid?: boolean,
  ) {
    return {
      uuid: ticket.ticket_uuid,
      seatLabel: ticket.seat_label,
      rowLabel: ticket.row_label,
      movieTitle: ticket.movie_title,
      cinemaName: ticket.cinema_name,
      screenNumber: ticket.screen_number,
      showtime: ticket.show_datetime,
      checkedIn,
      checkedInAt: ticket.used_at,
      signatureValid,
    };
  }
}

export const movieScanService = new MovieScanService();
