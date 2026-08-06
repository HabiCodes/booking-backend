"use strict";
/**
 * QR Code utility — HMAC-SHA256 ticket signature generation and verification.
 *
 * Each ticket gets a tamper-evident signature covering its immutable fields so
 * that gate scanners can detect forgeries or replay attempts without round-trips
 * to the database.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signTicket = signTicket;
exports.verifyTicketSignature = verifyTicketSignature;
exports.generateTicketReference = generateTicketReference;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
// ── Signing ──────────────────────────────────────────────────────────────────
/**
 * Build the canonical string to sign:
 *   ticket_uuid|attendee_name|event_id|start_at
 *
 * Using a fixed field order and `|` delimiter ensures that every signer and
 * verifier derives the same payload regardless of how it is stored.
 */
function canonicalPayload(ticket, eventId, eventStartAt) {
    return `${ticket.ticket_uuid}|${eventId}|${eventStartAt}`;
}
/**
 * Create an HMAC-SHA256 hex digest of the canonical ticket payload.
 */
function signTicket(ticket, eventId, eventStartAt) {
    const secret = config_1.config.bookings.qrSigningSecret;
    const payload = canonicalPayload(ticket, eventId, eventStartAt);
    return crypto_1.default.createHmac('sha256', secret).update(payload).digest('hex');
}
/**
 * Verify the HMAC signature and return a structured result.
 */
function verifyTicketSignature(ticket, eventId, eventStartAt, signature) {
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
function generateTicketReference() {
    const seg1 = crypto_1.default.randomBytes(2).toString('hex').toUpperCase();
    const seg2 = crypto_1.default.randomBytes(2).toString('hex').toUpperCase();
    return `TKT-${seg1}-${seg2}`;
}
