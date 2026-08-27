/**
 * TurfScanService — ticket verification for turf gate scanners.
 *
 * Reads from the turf_qr_tickets table joined with turf_bookings,
 * checks signature validity, booking status, and slot timing.
 *
 * Turf QR tickets store the canonical ticket UUID in the `token` field.
 * The HMAC signature is stored in the `metadata` JSONB column.
 *
 * Signatures are created during booking confirmation via UniversalTicketService
 * using: entityId = venue_id, startAt = slot start time.
 */

import { getPool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { verifyTicketSignature } from '../utils/qrCode';

export type TurfScanStatus = 'VALID' | 'ALREADY_SCANNED' | 'INVALID' | 'EXPIRED';

export interface TurfScanResult {
  status: TurfScanStatus;
  ticket?: {
    uuid: string;
    bookingReference: string;
    venueName: string;
    resourceName: string;
    slotStart: string;
    slotEnd: string;
    checkedIn: boolean;
    checkedInAt: string | null;
    signatureValid?: boolean;
  };
  message: string;
}

interface TurfTicketRow {
  ticket_uuid: string;
  booking_reference: string;
  booking_status: string;
  booking_created_at: string;
  booking_metadata: any;
  venue_id: number;
  venue_name: string;
  resource_name: string;
  qr_status: string;
  qr_used_at: string | null;
  qr_metadata: any;
  booking_deleted_at: string | null;
  booking_organization_id: number;
  au_starts_at: string;
  au_ends_at: string;
}

async function getTurfTicketWithDetails(uuid: string): Promise<TurfTicketRow | null> {
  const { rows } = await getPool().query(
    `SELECT
       qt.token AS ticket_uuid,
       b.booking_reference,
       b.status AS booking_status,
       b.created_at AS booking_created_at,
       b.metadata AS booking_metadata,
       v.id AS venue_id,
       v.name AS venue_name,
       r.name AS resource_name,
       qt.status AS qr_status,
       qt.used_at AS qr_used_at,
       qt.metadata AS qr_metadata,
       b.deleted_at AS booking_deleted_at,
       b.organization_id AS booking_organization_id,
       au.starts_at AS au_starts_at,
       au.ends_at AS au_ends_at
     FROM turf_qr_tickets qt
     JOIN turf_bookings b ON b.id = qt.booking_id
     JOIN turf_venues v ON v.id = b.venue_id
     JOIN turf_resources r ON r.id = b.resource_id
     JOIN turf_availability_units au ON au.id = b.availability_unit_id
     WHERE qt.token = $1 AND b.deleted_at IS NULL
     LIMIT 1`,
    [uuid]
  );
  return (rows as TurfTicketRow[])[0] || null;
}

function parseJsonField(value: unknown): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value as string);
  } catch {
    return null;
  }
}

export class TurfScanService {
  /**
   * Verify a turf ticket's current status:
   *  - EXPIRED: booking slot has ended
   *  - INVALID: ticket doesn't exist, soft-deleted, revoked, or signature mismatch
   *  - ALREADY_SCANNED: already checked in
   *  - VALID: everything checks out
   *
   * @param uuid - Ticket UUID to verify
   * @param adminOrganizationId - null for super-admin (all orgs), non-null restricts to that org
   */
  async verify(uuid: string, adminOrganizationId?: number | null): Promise<TurfScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getTurfTicketWithDetails(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    // Organization scoping: restrict admins to their own org's bookings
    if (adminOrganizationId !== undefined && adminOrganizationId !== null
        && ticket.booking_organization_id !== adminOrganizationId) {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Not authorized for this booking',
      };
    }

    // Revoked QR tickets are immediately invalid
    if (ticket.qr_status === 'revoked') {
      return {
        status: 'INVALID',
        message: 'Ticket has been revoked',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
      };
    }

    // Payment not completed — ticket not yet valid
    if (ticket.booking_status === 'pending_payment') {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Payment not completed — ticket not yet valid',
      };
    }

    // Cancelled booking
    if (ticket.booking_status === 'cancelled') {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Booking has been cancelled',
      };
    }

    // EXPIRED: slot has ended
    if (new Date(ticket.au_ends_at) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Booking slot has ended — ticket is no longer valid',
      };
    }

    // ALREADY_SCANNED
    if (ticket.qr_status === 'used') {
      return {
        status: 'ALREADY_SCANNED',
        ticket: this._toTicketInfo(ticket, true, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Ticket already scanned',
      };
    }

    // Verify HMAC signature — use au.starts_at which matches how the ticket was signed
    const signature = this._extractSignature(ticket.qr_metadata);

    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.venue_id,
      ticket.au_starts_at,
      signature
    );

    const signatureOk = sigResult.valid;

    return {
      status: signatureOk ? 'VALID' : 'INVALID',
      ticket: this._toTicketInfo(ticket, !!ticket.qr_used_at, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }, signatureOk),
      message: signatureOk ? 'Ticket is valid' : (sigResult.reason ?? 'Invalid signature'),
    };
  }

  /**
   * Mark a turf ticket as checked in. Returns the scan result.
   *
   * @param uuid - Ticket UUID to check in
   * @param adminId - Admin ID performing the check-in
   * @param adminOrganizationId - null for super-admin (all orgs), non-null restricts to that org
   */
  async markCheckedIn(uuid: string, adminId: number, adminOrganizationId?: number | null): Promise<TurfScanResult> {
    if (!uuid || typeof uuid !== 'string') {
      throw new AppError('Invalid ticket UUID', 400);
    }

    const ticket = await getTurfTicketWithDetails(uuid);
    if (!ticket) {
      return { status: 'INVALID', message: 'Ticket does not exist' };
    }

    // Organization scoping
    if (adminOrganizationId !== undefined && adminOrganizationId !== null
        && ticket.booking_organization_id !== adminOrganizationId) {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
        message: 'Not authorized for this booking',
      };
    }

    const slotTimes = { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at };

    // Revoked
    if (ticket.qr_status === 'revoked') {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, slotTimes),
        message: 'Ticket has been revoked',
      };
    }

    // Payment not completed
    if (ticket.booking_status === 'pending_payment') {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, slotTimes),
        message: 'Payment not completed — ticket not yet valid',
      };
    }

    // Cancelled
    if (ticket.booking_status === 'cancelled') {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, slotTimes),
        message: 'Booking has been cancelled',
      };
    }

    // EXPIRED
    if (new Date(ticket.au_ends_at) < new Date()) {
      return {
        status: 'EXPIRED',
        ticket: this._toTicketInfo(ticket, false, slotTimes),
        message: 'Booking slot has ended — cannot check in',
      };
    }

    // ALREADY_SCANNED
    if (ticket.qr_status === 'used') {
      return {
        status: 'ALREADY_SCANNED',
        ticket: this._toTicketInfo(ticket, true, slotTimes),
        message: 'Ticket was already scanned',
      };
    }

    // Verify HMAC signature before marking checked in
    const signature = this._extractSignature(ticket.qr_metadata);
    const sigResult = verifyTicketSignature(
      { ticket_uuid: ticket.ticket_uuid },
      ticket.venue_id,
      ticket.au_starts_at,
      signature
    );
    if (!sigResult.valid) {
      return {
        status: 'INVALID',
        ticket: this._toTicketInfo(ticket, false, slotTimes, false),
        message: sigResult.reason ?? 'Invalid signature — cannot check in',
      };
    }

    // Mark as used atomically (only if still 'issued')
    const { rows } = await getPool().query(
      `UPDATE turf_qr_tickets SET status = 'used', used_at = NOW(), metadata = jsonb_set(COALESCE(metadata, '{}'), '{checked_in_by}', $2::text::jsonb)
       WHERE token = $1 AND status = 'issued' RETURNING *`,
      [uuid, String(adminOrganizationId ?? 0)]
    );

    if ((rows as any[]).length === 0) {
      // Already scanned by another scanner — reload
      const refreshed = await getTurfTicketWithDetails(uuid);
      const refreshedSlot = refreshed
        ? { slotStart: refreshed.au_starts_at, slotEnd: refreshed.au_ends_at }
        : { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at };
      return {
        status: 'ALREADY_SCANNED',
        ticket: refreshed ? this._toTicketInfo(refreshed, true, refreshedSlot) : undefined,
        message: 'Ticket was already scanned',
      };
    }

    return {
      status: 'VALID',
      ticket: this._toTicketInfo(ticket, true, { slotStart: ticket.au_starts_at, slotEnd: ticket.au_ends_at }),
      message: 'Ticket checked in successfully',
    };
  }

  private _extractSignature(qrMetadata: unknown): string | null {
    const parsed = parseJsonField(qrMetadata);
    if (!parsed) return null;
    return parsed.signature || null;
  }

  private _toTicketInfo(
    ticket: TurfTicketRow,
    checkedIn: boolean,
    slot?: { slotStart: string; slotEnd: string } | null,
    signatureValid?: boolean,
  ) {
    return {
      uuid: ticket.ticket_uuid,
      bookingReference: ticket.booking_reference,
      venueName: ticket.venue_name,
      resourceName: ticket.resource_name,
      slotStart: slot?.slotStart || '',
      slotEnd: slot?.slotEnd || '',
      checkedIn,
      checkedInAt: ticket.qr_used_at,
      signatureValid,
    };
  }
}

export const turfScanService = new TurfScanService();
