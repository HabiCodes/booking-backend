/**
 * Turf Booking State Machine.
 *
 * Mirrors the legacy Turf backend's state transitions exactly.
 */

import { AppError } from '../middleware/errorHandler';

export const TURF_BOOKING_STATES = {
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  CHECKED_IN: 'checked_in',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  EXPIRED: 'expired',
} as const;

export const TURF_BOOKING_TRANSITIONS: Record<string, readonly string[]> = {
  [TURF_BOOKING_STATES.PENDING_PAYMENT]: ['confirmed', 'cancelled', 'expired'],
  [TURF_BOOKING_STATES.CONFIRMED]: ['checked_in', 'cancelled', 'refunded'],
  [TURF_BOOKING_STATES.CHECKED_IN]: ['completed', 'refunded'],
  [TURF_BOOKING_STATES.COMPLETED]: ['refunded'],
  [TURF_BOOKING_STATES.CANCELLED]: [],
  [TURF_BOOKING_STATES.REFUNDED]: [],
  [TURF_BOOKING_STATES.EXPIRED]: [],
};

export function canTransition(from: string, to: string): boolean {
  const allowed = TURF_BOOKING_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function transitionReason(from: string, to: string): string | null {
  if (!canTransition(from, to)) return `${from} → ${to} is not a valid transition`;
  return null;
}

export function isTerminal(status: string): boolean {
  const transitions = TURF_BOOKING_TRANSITIONS[status];
  return transitions ? transitions.length === 0 : true;
}

/**
 * Assert that a state transition is legal. Throws AppError if not.
 */
export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      `Cannot transition booking from "${from}" to "${to}"`,
      409
    );
  }
}
