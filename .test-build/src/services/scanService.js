"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanService = exports.ScanService = void 0;
const bookingRepository_1 = require("../repositories/bookingRepository");
const pool_1 = require("../db/pool");
const errorHandler_1 = require("../middleware/errorHandler");
const qrCode_1 = require("../utils/qrCode");
async function getTicketWithEvent(uuid) {
    const { rows } = await (0, pool_1.getPool)().query(`SELECT t.ticket_uuid, t.attendee_name, t.checked_in, t.checked_in_at,
            t.signature, t.deleted_at AS ticket_deleted_at,
            e.id AS event_id, e.title AS event_title, e.start_at AS event_start_at,
            e.end_at AS event_end_at, e.deleted_at AS event_deleted_at
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       WHERE t.ticket_uuid = $1
       LIMIT 1`, [uuid]);
    return rows[0] || null;
}
function toCheckedInAtIso(value) {
    if (!value)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    return new Date(value).toISOString();
}
class ScanService {
    /**
     * Verify a ticket's current status:
     *  - EXPIRED: event has ended
     *  - INVALID: ticket doesn't exist, soft-deleted, or signature mismatch
     *  - ALREADY_SCANNED: checked_in = true
     *  - VALID: everything checks out
     */
    async verify(uuid) {
        if (!uuid || typeof uuid !== 'string') {
            throw new errorHandler_1.AppError('Invalid ticket UUID', 400);
        }
        const ticket = await getTicketWithEvent(uuid);
        if (!ticket || ticket.ticket_deleted_at !== null) {
            return { status: 'INVALID', message: 'Ticket does not exist' };
        }
        if (ticket.event_deleted_at !== null || ticket.event_title === null) {
            return { status: 'INVALID', message: 'Event has been removed' };
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
                    signature_valid: true,
                },
                message: `Already scanned at ${checkedInAtIso}`,
            };
        }
        // ── Signature validation ─────────────────────────────────────────────────
        const sigResult = (0, qrCode_1.verifyTicketSignature)({ ticket_uuid: ticket.ticket_uuid }, ticket.event_id, ticket.event_start_at, ticket.signature);
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
     */
    async markCheckedIn(uuid, adminId) {
        if (!uuid || typeof uuid !== 'string') {
            throw new errorHandler_1.AppError('Invalid ticket UUID', 400);
        }
        const ticket = await getTicketWithEvent(uuid);
        if (!ticket || ticket.ticket_deleted_at !== null) {
            return { status: 'INVALID', message: 'Ticket does not exist' };
        }
        const checkedInAtIso = toCheckedInAtIso(ticket.checked_in_at);
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
        const success = await bookingRepository_1.bookingRepository.markTicketCheckedIn(uuid, adminId);
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
exports.ScanService = ScanService;
exports.scanService = new ScanService();
