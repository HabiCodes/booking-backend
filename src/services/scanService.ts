import { bookingRepository } from '../repositories/bookingRepository';
import { getPool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';

export type ScanStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';

export interface ScanResult {
  status: ScanStatus;
  ticket?: {
    uuid: string;
    attendee_name: string;
    event_title: string;
    checked_in: boolean;
    checked_in_at: string | null;
  };
  message: string;
}

interface TicketWithEvent {
  ticket_uuid: string;
  attendee_name: string;
  event_title: string;
  checked_in: boolean;
  checked_in_at: Date | string | null;
}

async function getTicketWithEvent(uuid: string): Promise<TicketWithEvent | null> {
  const { rows } = await getPool().query(
    `SELECT t.ticket_uuid, t.attendee_name, t.checked_in, t.checked_in_at,
            e.title AS event_title
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       WHERE t.ticket_uuid = $1
       LIMIT 1`,
    [uuid]
  );
  return (rows as unknown as TicketWithEvent[])[0] || null;
}

function toCheckedInAtIso(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export class ScanService {
  async verify(uuid: string): Promise<ScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getTicketWithEvent(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    const checkedInAtIso = toCheckedInAtIso(ticket.checked_in_at);

    return {
      status: ticket.checked_in ? 'ALREADY_SCANNED' : 'VALID',
      ticket: {
        uuid: ticket.ticket_uuid,
        attendee_name: ticket.attendee_name,
        event_title: ticket.event_title,
        checked_in: !!ticket.checked_in,
        checked_in_at: checkedInAtIso,
      },
      message: ticket.checked_in
        ? `Already scanned at ${checkedInAtIso}`
        : 'Ticket is valid',
    };
  }

  async markCheckedIn(uuid: string, adminId: number): Promise<ScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const success = await bookingRepository.markTicketCheckedIn(uuid, adminId);
    const ticket = await getTicketWithEvent(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    const checkedInAtIso = toCheckedInAtIso(ticket.checked_in_at);

    if (!success) {
      return {
        status: 'ALREADY_SCANNED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: true,
          checked_in_at: checkedInAtIso,
        },
        message: 'Ticket was already scanned',
      };
    }

    return {
      status: 'VALID',
      ticket: {
        uuid: ticket.ticket_uuid,
        attendee_name: ticket.attendee_name,
        event_title: ticket.event_title,
        checked_in: true,
        checked_in_at: checkedInAtIso,
      },
      message: 'Ticket checked in successfully',
    };
  }
}

export const scanService = new ScanService();
