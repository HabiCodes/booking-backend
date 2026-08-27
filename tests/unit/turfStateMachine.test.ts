/**
 * Tests for turfBookingService state machine — NO CUSTOMER REFUND enforcement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { assertTransition, TURF_BOOKING_STATES, TURF_BOOKING_TRANSITIONS } from '../../src/services/turfStateMachine';

describe('turfStateMachine — NO CUSTOMER REFUND policy', () => {

  it('confirmed → refunded is NOT allowed', () => {
    assert.throws(() => {
      assertTransition(TURF_BOOKING_STATES.CONFIRMED, TURF_BOOKING_STATES.REFUNDED);
    }, /Cannot transition/);
  });

  it('checked_in → refunded is NOT allowed', () => {
    assert.throws(() => {
      assertTransition(TURF_BOOKING_STATES.CHECKED_IN, TURF_BOOKING_STATES.REFUNDED);
    }, /Cannot transition/);
  });

  it('completed → refunded is NOT allowed', () => {
    assert.throws(() => {
      assertTransition(TURF_BOOKING_STATES.COMPLETED, TURF_BOOKING_STATES.REFUNDED);
    }, /Cannot transition/);
  });

  it('confirmed → cancelled IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.CONFIRMED, TURF_BOOKING_STATES.CANCELLED);
    });
  });

  it('checked_in → cancelled IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.CHECKED_IN, TURF_BOOKING_STATES.CANCELLED);
    });
  });

  it('completed → cancelled IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.COMPLETED, TURF_BOOKING_STATES.CANCELLED);
    });
  });

  it('pending_payment → confirmed IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.PENDING_PAYMENT, TURF_BOOKING_STATES.CONFIRMED);
    });
  });

  it('pending_payment → cancelled IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.PENDING_PAYMENT, TURF_BOOKING_STATES.CANCELLED);
    });
  });

  it('pending_payment → expired IS allowed', () => {
    assert.doesNotThrow(() => {
      assertTransition(TURF_BOOKING_STATES.PENDING_PAYMENT, TURF_BOOKING_STATES.EXPIRED);
    });
  });

  it('refunded has no outgoing transitions', () => {
    const transitions = TURF_BOOKING_TRANSITIONS[TURF_BOOKING_STATES.REFUNDED];
    assert.strictEqual(transitions.length, 0, 'refunded should have no outgoing transitions');
  });

  it('cancelled has no outgoing transitions', () => {
    const transitions = TURF_BOOKING_TRANSITIONS[TURF_BOOKING_STATES.CANCELLED];
    assert.strictEqual(transitions.length, 0, 'cancelled should have no outgoing transitions');
  });
});
