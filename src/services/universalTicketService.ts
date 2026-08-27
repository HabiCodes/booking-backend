/**
 * UniversalTicketService — shared ticket operations across all booking domains
 * (Event, Turf, Movie, and future domains like Concerts, Stand-up, Workshops).
 *
 * This service provides:
 *   - Canonical ticket UUID generation (domain-prefixed for collision safety)
 *   - HMAC-SHA256 signing via the shared qrCode utility
 *   - Signature verification (constant-time, timing-attack resistant)
 *   - Ticket reference generation (human-friendly)
 *   - Domain-agnostic ticket payload abstraction
 *
 * All domains MUST use this service for ticket operations to ensure:
 *   - Consistent signature algorithm and key (QR_SIGNING_SECRET)
 *   - Uniform canonical payload format
 *   - Constant-time comparison everywhere
 */

import crypto from 'crypto';
import { signTicket, verifyTicketSignature, generateTicketReference } from '../utils/qrCode';
import { logger } from '../utils/logger';
import type { TicketRow, EventRow } from '../types';

// ── Domain identifiers ────────────────────────────────────────────────────────

export type TicketDomain = 'event' | 'turf' | 'movie' | 'movie_manager';

export const DOMAIN_PREFIXES: Record<TicketDomain, string> = {
  event: 'evt',
  turf: 'trf',
  movie: 'mov',
  movie_manager: 'mgm',
};

// ── Ticket signing input ──────────────────────────────────────────────────────

/**
 * Minimal data needed to sign any ticket across all domains.
 * Each domain maps its own ticket/booking data to this shape.
 */
export interface SignTicketInput {
  domain: TicketDomain;
  /** Domain-specific ticket UUID (without prefix) */
  ticketUuid: string;
  /** Domain-specific entity ID (event_id, showtime_id, turf_booking_id, etc.) */
  entityId: number;
  /** ISO-8601 start timestamp of the event/showtime/session */
  startAt: string;
}

export interface VerifyTicketInput {
  domain: TicketDomain;
  ticketUuid: string;
  entityId: number;
  startAt: string;
  signature: string | null | undefined;
}

// ── Ticket scan result ────────────────────────────────────────────────────────

export type ScanResult =
  | { valid: true }
  | { valid: false; reason: 'INVALID_UUID' }
  | { valid: false; reason: 'NO_SIGNATURE' }
  | { valid: false; reason: 'SIGNATURE_MISMATCH' }
  | { valid: false; reason: 'WRONG_EVENT' }
  | { valid: false; reason: 'EXPIRED' }
  | { valid: false; reason: 'CANCELLED' }
  | { valid: false; reason: 'ALREADY_USED' };

// ── Service ───────────────────────────────────────────────────────────────────

export class UniversalTicketService {
  /**
   * Generate a globally unique ticket UUID with domain prefix.
   * Format: <DOMAIN_PREFIX>_<timestamp>_<random_hex>
   * Example: evt_1724000000_A3F28B1C
   */
  static generateTicketUuid(domain: TicketDomain): string {
    const prefix = DOMAIN_PREFIXES[domain];
    const timestamp = Math.floor(Date.now() / 1000).toString(16).toUpperCase();
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}_${timestamp}_${random}`;
  }

  /**
   * Generate a human-friendly ticket reference for display/print.
   * Format: TKT-XXXX-XXXX
   */
  static generateTicketReference(): string {
    return generateTicketReference();
  }

  /**
   * Sign a ticket using the shared HMAC-SHA256 scheme.
   * The canonical payload is: ticket_uuid|entity_id|start_at
   */
  static sign(input: SignTicketInput): string {
    return signTicket(
      { ticket_uuid: input.ticketUuid },
      input.entityId,
      input.startAt
    );
  }

  /**
   * Verify a ticket's HMAC signature using constant-time comparison.
   */
  static verify(input: VerifyTicketInput): { valid: boolean; reason?: string } {
    return verifyTicketSignature(
      { ticket_uuid: input.ticketUuid },
      input.entityId,
      input.startAt,
      input.signature
    );
  }

  /**
   * Verify a ticket with domain-specific business rules.
   * Checks signature validity plus domain rules (expiry, cancellation, usage).
   *
   * @param input - Verification input
   * @param checks - Domain-specific ticket state checks
   */
  static verifyWithBusinessRules(
    input: VerifyTicketInput,
    checks: {
      isExpired: () => boolean;
      isCancelled: () => boolean;
      isAlreadyUsed: () => boolean;
      expectedEntityId?: number;
    }
  ): ScanResult {
    // 1. Signature check
    const sigResult = this.verify(input);
    if (!sigResult.valid) {
      if (sigResult.reason?.includes('no signature')) {
        return { valid: false, reason: 'NO_SIGNATURE' };
      }
      if (sigResult.reason?.includes('mismatch') || sigResult.reason?.includes('forged')) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' };
      }
      return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    // 2. Domain/business rule checks
    if (checks.expectedEntityId !== undefined && input.entityId !== checks.expectedEntityId) {
      return { valid: false, reason: 'WRONG_EVENT' };
    }

    if (checks.isExpired()) {
      return { valid: false, reason: 'EXPIRED' };
    }

    if (checks.isCancelled()) {
      return { valid: false, reason: 'CANCELLED' };
    }

    if (checks.isAlreadyUsed()) {
      return { valid: false, reason: 'ALREADY_USED' };
    }

    return { valid: true };
  }

  /**
   * Extract domain prefix from a ticket UUID.
   * Returns null if the UUID doesn't match any known domain prefix.
   */
  static detectDomain(ticketUuid: string): TicketDomain | null {
    const prefix = ticketUuid.split('_')[0];
    if (prefix === DOMAIN_PREFIXES.event) return 'event';
    if (prefix === DOMAIN_PREFIXES.turf) return 'turf';
    if (prefix === DOMAIN_PREFIXES.movie) return 'movie';
    if (prefix === DOMAIN_PREFIXES.movie_manager) return 'movie_manager';
    return null;
  }
}
