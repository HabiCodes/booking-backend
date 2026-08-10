"use strict";
/**
 * Turf Booking State Machine.
 *
 * Mirrors the legacy Turf backend's state transitions exactly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TURF_BOOKING_TRANSITIONS = exports.TURF_BOOKING_STATES = void 0;
exports.canTransition = canTransition;
exports.transitionReason = transitionReason;
exports.isTerminal = isTerminal;
exports.assertTransition = assertTransition;
const errorHandler_1 = require("../middleware/errorHandler");
exports.TURF_BOOKING_STATES = {
    PENDING_PAYMENT: 'pending_payment',
    CONFIRMED: 'confirmed',
    CHECKED_IN: 'checked_in',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    REFUNDED: 'refunded',
    EXPIRED: 'expired',
};
exports.TURF_BOOKING_TRANSITIONS = {
    [exports.TURF_BOOKING_STATES.PENDING_PAYMENT]: ['confirmed', 'cancelled', 'expired'],
    [exports.TURF_BOOKING_STATES.CONFIRMED]: ['checked_in', 'cancelled', 'refunded'],
    [exports.TURF_BOOKING_STATES.CHECKED_IN]: ['completed', 'refunded'],
    [exports.TURF_BOOKING_STATES.COMPLETED]: ['refunded'],
    [exports.TURF_BOOKING_STATES.CANCELLED]: [],
    [exports.TURF_BOOKING_STATES.REFUNDED]: [],
    [exports.TURF_BOOKING_STATES.EXPIRED]: [],
};
function canTransition(from, to) {
    const allowed = exports.TURF_BOOKING_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
}
function transitionReason(from, to) {
    if (!canTransition(from, to))
        return `${from} → ${to} is not a valid transition`;
    return null;
}
function isTerminal(status) {
    const transitions = exports.TURF_BOOKING_TRANSITIONS[status];
    return transitions ? transitions.length === 0 : true;
}
/**
 * Assert that a state transition is legal. Throws AppError if not.
 */
function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new errorHandler_1.AppError(`Cannot transition booking from "${from}" to "${to}"`, 409);
    }
}
