import { bookingRepository } from '../repositories/bookingRepository';
import { getPool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { verifyTicketSignature } from '../utils/qrCode';

export type ScanStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';

export interface ScanResult {
  status: ScanStatus;
  ticket?: {
    uuid: string;
    attendee_name: string;
    event_title: string;
    checked_in: boolean;
    checked_in_at: string | null;
    signature_valid?: boolean;
  };
  message: string;
}

interface TicketWithEvent {
  ticket_uuid: string;
  attendee_name: string;
  event_id: number;
  event_title: string;
  checked_in: boolean;
  checked_in_at: Date | string | null;
  event_start_at: string;
  event_end_at: string | null;
  signature: string | null;
  ticket_deleted_at: string | null;
  event_deleted_at: string | null;
  booking_status: string;
  event_organization_id: number | null;
}

async function getTicketWithEvent(uuid: string): Promise<TicketWithEvent | null> {
  const { rows } = await getPool().query(
    `SELECT t.ticket_uuid, t.attendee_name, t.checked_in, t.checked_in_at,
            t.signature, t.deleted_at AS ticket_deleted_at,
            e.id AS event_id, e.title AS event_title, e.start_at AS event_start_at,
            e.end_at AS event_end_at, e.deleted_at AS event_deleted_at, e.organization_id AS event_organization_id,
            b.status AS booking_status
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
  /**
   * Verify a ticket's current status:
   *  - EXPIRED: event has ended
   *  - INVALID: ticket doesn't exist, soft-deleted, signature mismatch, or org-scoped unauthorized
   *  - ALREADY_SCANNED: checked_in = true
   *  - VALID: everything checks out
   *
   * @param uuid - Ticket UUID to verify
   * @param adminOrganizationId - null for super-admin (all orgs), non-null restricts to that org
   */
  async verify(uuid: string, adminOrganizationId?: number | null): Promise<ScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getTicketWithEvent(uuid);
    if (!ticket || ticket.ticket_deleted_at !== null) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }
    if (ticket.event_deleted_at !== null || ticket.event_title === null) {
      return { status: 'INVALID', message: 'Event has been removed' };
    }

    // Organization scoping: restrict admins to their own org's events
    if (adminOrganizationId !== undefined && adminOrganizationId !== null
        && ticket.event_organization_id !== adminOrganizationId) {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Not authorized for this event',
      };
    }

    // ── PAYMENT PENDING: ticket not yet confirmed ────────────────────────────
    if (ticket.booking_status === 'payment_pending') {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Payment not completed — ticket not yet valid',
      };
    }

    // ── CANCELLED booking ───────────────────────────────────────────────────
    if (ticket.booking_status === 'cancelled') {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Booking has been cancelled',
      };
    }

    const checkedInAtIso = toCheckedInAtIso(ticket.checked_in_at);

    // ── EXPIRED check: event end_at has passed ──────────────────────────────
    if (ticket.event_end_at && new Date(ticket.event_end_at) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: !!ticket.checked_in,
          checked_in_at: checkedInAtIso,
          signature_valid: false,
        },
        message: 'Event has ended — ticket is no longer valid',
      };
    }

    // ── ALREADY_SCANNED ─────────────────────────────────────────────────────
    if (ticket.checked_in) {
      return {
        status: 'ALREADY_SCANNED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: true,
          checked_in_at: checkedInAtIso,
          signature_valid: !!ticket.signature,
        },
        message: `Already scanned at ${checkedInAtIso}`,
      };
    }

    // ── Signature validation ─────────────────────────────────────────────────
    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.event_id,
      ticket.event_start_at,
      ticket.signature
    );

    const signatureOk = sigResult.valid;

    return {
      status: signatureOk ? 'VALID' : 'INVALID',
      ticket: {
        uuid: ticket.ticket_uuid,
        attendee_name: ticket.attendee_name,
        event_title: ticket.event_title,
        checked_in: false,
        checked_in_at: null,
        signature_valid: signatureOk,
      },
      message: signatureOk ? 'Ticket is valid' : (sigResult.reason ?? 'Ticket signature invalid'),
    };
  }

  /**
   * Mark a ticket as checked in. Returns the scan result.
   *
   * @param uuid - Ticket UUID to check in
   * @param adminId - Admin ID performing the check-in
   * @param adminOrganizationId - null for super-admin (all orgs), non-null restricts to that org
   */
  async markCheckedIn(uuid: string, adminId: number, adminOrganizationId?: number | null): Promise<ScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getTicketWithEvent(uuid);
    if (!ticket || ticket.ticket_deleted_at !== null) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    // Organization scoping
    if (adminOrganizationId !== undefined && adminOrganizationId !== null
        && ticket.event_organization_id !== adminOrganizationId) {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Not authorized for this event',
      };
    }

    const checkedInAtIso = toCheckedInAtIso(ticket.checked_in_at);

    // ── PAYMENT PENDING: ticket not yet confirmed ────────────────────────────
    if (ticket.booking_status === 'payment_pending') {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Payment not completed — ticket not yet valid',
      };
    }

    // ── CANCELLED booking ───────────────────────────────────────────────────
    if (ticket.booking_status === 'cancelled') {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: 'Booking has been cancelled',
      };
    }

    // ── EXPIRED ─────────────────────────────────────────────────────────────
    if (ticket.event_end_at && new Date(ticket.event_end_at) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: !!ticket.checked_in,
          checked_in_at: checkedInAtIso,
          signature_valid: false,
        },
        message: 'Event has ended — cannot check in',
      };
    }

    // ── ALREADY_SCANNED ─────────────────────────────────────────────────────
    if (ticket.checked_in) {
      return {
        status: 'ALREADY_SCANNED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: true,
          checked_in_at: checkedInAtIso,
          signature_valid: !!ticket.signature,
        },
        message: 'Ticket was already scanned',
      };
    }

    // Verify HMAC signature before marking checked in
    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.event_id,
      ticket.event_start_at,
      ticket.signature
    );
    if (!sigResult.valid) {
      return {
        status: 'INVALID',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: false,
          checked_in_at: null,
          signature_valid: false,
        },
        message: sigResult.reason ?? 'Invalid signature — cannot check in',
      };
    }

    const success = await bookingRepository.markTicketCheckedIn(uuid, adminId);

    if (!success) {
      const refreshed = await getTicketWithEvent(uuid);
      const freshIso = refreshed ? toCheckedInAtIso(refreshed.checked_in_at) : checkedInAtIso;
      return {
        status: 'ALREADY_SCANNED',
        ticket: {
          uuid: ticket.ticket_uuid,
          attendee_name: ticket.attendee_name,
          event_title: ticket.event_title,
          checked_in: true,
          checked_in_at: freshIso,
          signature_valid: !!ticket.signature,
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
        checked_in_at: new Date().toISOString(),
        signature_valid: !!ticket.signature,
      },
      message: 'Ticket checked in successfully',
    };
  }
}

export const scanService = new ScanService();
