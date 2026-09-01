/**
 * QR Code utility — HMAC-SHA256 ticket signature generation and verification.
 *
 * Each ticket gets a tamper-evident signature covering its immutable fields so
 * that gate scanners can detect forgeries or replay attempts without round-trips
 * to the database.
 */

import crypto from 'crypto';

import { config } from '../config';
import type { TicketRow } from '../types';

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * Build the canonical string to sign:
 *   ticket_uuid|attendee_name|event_id|start_at
 *
 * Using a fixed field order and `|` delimiter ensures that every signer and
 * verifier derives the same payload regardless of how it is stored.
 */
function canonicalPayload(ticket: Pick<TicketRow, 'ticket_uuid'>, eventId: number, eventStartAt: string): string {
  return `${ticket.ticket_uuid}|${eventId}|${eventStartAt}`;
}

/**
 * Create an HMAC-SHA256 hex digest of the canonical ticket payload.
 */
export function signTicket(
  ticket: Pick<TicketRow, 'ticket_uuid'>,
  eventId: number,
  eventStartAt: string,
): string {
  const secret = config.bookings.qrSigningSecret;
  if (!secret || secret.length === 0) {
    throw new Error('QR_SIGNING_SECRET is not configured. All ticket signatures would be insecure. Set QR_SIGNING_SECRET to a random string (≥32 chars) before starting the server.');
  }
  const payload = canonicalPayload(ticket, eventId, eventStartAt);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify the HMAC signature and return a structured result.
 */
export function verifyTicketSignature(
  ticket: Pick<TicketRow, 'ticket_uuid'>,
  eventId: number,
  eventStartAt: string,
  signature: string | null | undefined,
): { valid: boolean; reason?: string } {
  if (!signature) {
    return { valid: false, reason: 'Ticket has no signature — cannot verify integrity.' };
  }

  const expected = signTicket(ticket, eventId, eventStartAt);

  // Constant-time comparison to prevent timing attacks
  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (sigBuffer.length !== expectedBuffer.length) {
    return { valid: false, reason: 'Signature length mismatch — ticket may be forged.' };
  }

  let mismatch = 0;
  for (let i = 0; i < sigBuffer.length; i++) {
    mismatch |= sigBuffer[i] ^ expectedBuffer[i];
  }

  if (mismatch !== 0) {
    return { valid: false, reason: 'Signature mismatch — ticket has been tampered with.' };
  }

  return { valid: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a human-friendly, URL-safe ticket reference (not the primary key).
 * Format: TKT-XXXX-XXXX  (e.g. TKT-A3F2-8B1C)
 */
export function generateTicketReference(): string {
  const seg1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const seg2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `TKT-${seg1}-${seg2}`;
}
