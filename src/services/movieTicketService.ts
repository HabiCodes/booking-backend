/**
 * MovieTicketService — ticket generation, signing, and verification.
 *
 * Tickets carry an HMAC-SHA256 signature for anti-forgery.
 * QR payloads are JSON strings scannable by client apps.
 */

import { movieTicketRepository } from '../repositories/movieTicketRepository';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { signTicket, verifyTicketSignature } from '../utils/qrCode';
import { logger } from '../utils/logger';
import type { MovieTicketPublic, MovieTicketWithDetails, MovieTicketRow, MovieSeatType, MovieTicketStatus } from '../types';

export interface TicketVerificationResult {
  valid: boolean;
  reason?: string;
  ticketUuid?: string;
  status?: string;
  seatLabel?: string;
  rowLabel?: string;
  seatNumber?: number;
  seatType?: string;
  usedAt?: string | null;
  revokedAt?: string | null;
}

export class MovieTicketService {

  async getTicketsForUser(userId: number, bookingReference: string): Promise<MovieTicketPublic[]> {
    const tickets = await movieTicketRepository.findByReference(bookingReference);
    // Verify user ownership via booking
    if (tickets.length > 0) {
      const bookingId = tickets[0].booking_id;
      const booking = await movieBookingRepository.findById(bookingId);
      if (!booking || booking.user_id !== userId) {
        throw new Error('Not your booking');
      }
    }
    return tickets.map(toPublic);
  }

  async verifyTicket(ticketUuid: string): Promise<TicketVerificationResult> {
    const ticket = await movieTicketRepository.findByUuid(ticketUuid);
    if (!ticket) {
      return { valid: false, reason: 'Ticket not found' };
    }

    // Verify signature using constant-time comparison
    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.showtime_id,
      '',
      ticket.signature
    );

    const result: TicketVerificationResult = {
      valid: sigResult.valid,
      ticketUuid: ticket.ticket_uuid,
      status: ticket.status,
      seatLabel: ticket.seat_label,
      rowLabel: ticket.row_label,
      seatNumber: ticket.seat_number,
      seatType: ticket.seat_type,
      usedAt: ticket.used_at,
      revokedAt: ticket.revoked_at,
    };

    if (!sigResult.valid) {
      result.reason = 'Invalid signature';
    }

    if (ticket.status === 'used') {
      result.valid = false;
      result.reason = 'Ticket already used';
    }

    if (ticket.status === 'revoked') {
      result.valid = false;
      result.reason = 'Ticket has been revoked';
    }

    return result;
  }

  async getTicketDetails(ticketUuid: string): Promise<MovieTicketWithDetails | null> {
    return movieTicketRepository.getTicketWithDetails(ticketUuid);
  }
}

function toPublic(row: MovieTicketRow): MovieTicketPublic {
  return {
    id: row.id as number,
    bookingId: row.booking_id as number,
    bookingItemId: row.booking_item_id as number,
    ticketUuid: row.ticket_uuid as string,
    showtimeId: row.showtime_id as number,
    seatLabel: row.seat_label as string,
    rowLabel: row.row_label as string,
    seatNumber: row.seat_number as number,
    seatType: row.seat_type as MovieSeatType,
    qrData: row.qr_data as string,
    signature: row.signature as string,
    status: row.status as MovieTicketStatus,
    usedAt: row.used_at as string | null,
    revokedAt: row.revoked_at as string | null,
    createdAt: row.created_at as string,
  };
}

export const movieTicketService = new MovieTicketService();