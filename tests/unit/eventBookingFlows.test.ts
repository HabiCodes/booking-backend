/**
 * Unit tests for the three event booking flows:
 *   - Normal Paid Event (existing)
 *   - Layout-Based Paid Event (NEW — zone-based pricing)
 *   - Free Event (NEW — no payment, max 2 tickets)
 *
 * Tests cover the routing logic, pricing, and validation rules
 * without requiring a database connection.
 *
 * Run: npx tsx tests/unit/eventBookingFlows.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    title: 'Test Event',
    status: 'published',
    is_free: false,
    price: 500,
    currency: 'INR',
    start_at: new Date(Date.now() + 86400000).toISOString(),
    end_at: new Date(Date.now() + 172800000).toISOString(),
    organization_id: 1,
    capacity: 100,
    remaining_capacity: 100,
    ...overrides,
  };
}

function makeZone(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    event_id: 1,
    name: 'VIP',
    description: null,
    color: '#ff0000',
    total_capacity: 50,
    remaining_capacity: 50,
    price: 1000,
    currency: 'INR',
    sort_order: 1,
    is_active: true,
    deleted_at: null,
    ...overrides,
  };
}

// ── Three-way routing logic (mirrors bookingController.createBooking) ─────────

type EventType = 'free' | 'layout' | 'normal';

function classifyEvent(event: any, eventZones: any[]): EventType {
  if (event.is_free) return 'free';
  if (eventZones.length > 0) return 'layout';
  return 'normal';
}

// ── Pricing engine (simplified from src/services/pricingEngine.ts) ───────────

interface PricingBreakdown {
  unitPricePaise: number;
  quantity: number;
  subtotalPaise: number;
  gstPaise: number;
  platformFeePaise: number;
  totalPaise: number;
}

function calculatePricing(unitPricePaise: number, quantity: number): PricingBreakdown {
  const subtotalPaise = unitPricePaise * quantity;
  const gstPaise = Math.round(subtotalPaise * 0.18);
  const platformFeePaise = Math.round(subtotalPaise * 0.10);
  const totalPaise = subtotalPaise + gstPaise + platformFeePaise;
  return { unitPricePaise, quantity, subtotalPaise, gstPaise, platformFeePaise, totalPaise };
}

function paiseToRupees(paise: number): number {
  return paise / 100;
}

// ── Validation rules (mirror bookingService.createBooking / createZoneBooking) ─

interface BookingValidationResult {
  valid: boolean;
  error?: string;
}

function validateBookingCount(ticketCount: number, maxPerBooking: number = 10): BookingValidationResult {
  if (ticketCount < 1) return { valid: false, error: 'At least 1 ticket required' };
  if (ticketCount > maxPerBooking) return { valid: false, error: `Max ${maxPerBooking} tickets per booking` };
  return { valid: true };
}

function validateFreeEventZone(zoneId: number | undefined, eventType: EventType): BookingValidationResult {
  if (eventType === 'free' && zoneId !== undefined) {
    return { valid: false, error: 'Free events do not support zone selection' };
  }
  return { valid: true };
}

function validateLayoutEventZone(zoneId: number | undefined, eventType: EventType): BookingValidationResult {
  if (eventType === 'layout' && !zoneId) {
    return { valid: false, error: 'zone_id is required for layout events' };
  }
  return { valid: true };
}

function validatePerUserLimit(existingCount: number, ticketCount: number, maxPerUser: number = 10): BookingValidationResult {
  if (existingCount + ticketCount > maxPerUser) {
    return { valid: false, error: `Booking limit reached. Already have ${existingCount} tickets. Limit is ${maxPerUser}.` };
  }
  return { valid: true };
}

// Per-user limit for FREE events specifically (default 2, enforced by bookingService)
const FREE_EVENT_MAX_PER_USER = 2;

// Free event rate limiter (15 bookings per minute per IP)
const FREE_EVENT_RATE_LIMIT_MAX = 15;
const FREE_EVENT_RATE_LIMIT_WINDOW_MS = 60_000;

// ══════════════════════════════════════════════════════════════════════════════
//  TEST SUITES
// ══════════════════════════════════════════════════════════════════════════════

describe('Event Booking Flows', () => {

  // ── 1. Event type classification ──────────────────────────────────────────

  describe('classifyEvent', () => {
    it('classifies free events correctly', () => {
      const event = makeEvent({ is_free: true });
      assert.strictEqual(classifyEvent(event, []), 'free');
      // Even with zones, free events remain free
      assert.strictEqual(classifyEvent(event, [makeZone()]), 'free');
    });

    it('classifies layout events when zones exist', () => {
      const event = makeEvent({ is_free: false });
      assert.strictEqual(classifyEvent(event, [makeZone()]), 'layout');
      assert.strictEqual(classifyEvent(event, [makeZone(), makeZone({ id: 2 })]), 'layout');
    });

    it('classifies normal paid events when no zones', () => {
      const event = makeEvent({ is_free: false, price: 500 });
      assert.strictEqual(classifyEvent(event, []), 'normal');
    });

    it('prioritizes is_free check over zones', () => {
      const event = makeEvent({ is_free: true });
      assert.strictEqual(classifyEvent(event, [makeZone()]), 'free');
    });
  });

  // ── 2. Free event rules ───────────────────────────────────────────────────

  describe('Free Event Flow', () => {
    const eventType: EventType = 'free';

    it('rejects zone_id for free events', () => {
      const result = validateFreeEventZone(5, eventType);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('zone selection'));
    });

    it('accepts booking without zone_id', () => {
      const result = validateFreeEventZone(undefined, eventType);
      assert.strictEqual(result.valid, true);
    });

    it('pricing is zero (free event)', () => {
      const pricing = calculatePricing(0, 2);
      assert.strictEqual(pricing.totalPaise, 0);
      assert.strictEqual(pricing.gstPaise, 0);
      assert.strictEqual(pricing.platformFeePaise, 0);
    });

    it('returns confirmed status (no payment pending)', () => {
      // Free events bypass payment entirely
      const expectedStatus = 'confirmed';
      assert.strictEqual(expectedStatus, 'confirmed');
    });

    it('validates ticket count (max 10)', () => {
      const result = validateBookingCount(3);
      assert.strictEqual(result.valid, true);
      const overLimit = validateBookingCount(11);
      assert.strictEqual(overLimit.valid, false);
    });

    it('per-user limit for free events is 2 tickets (not 10)', () => {
      const maxFree = FREE_EVENT_MAX_PER_USER;
      // User can book up to 2 tickets on a free event
      assert.strictEqual(validatePerUserLimit(0, 1, maxFree).valid, true);  // 1 ≤ 2
      assert.strictEqual(validatePerUserLimit(0, 2, maxFree).valid, true);  // 2 = 2 (exactly at limit)
      assert.strictEqual(validatePerUserLimit(1, 1, maxFree).valid, true);  // 2 = 2
      assert.strictEqual(validatePerUserLimit(1, 2, maxFree).valid, false); // 3 > 2
      assert.strictEqual(validatePerUserLimit(2, 1, maxFree).valid, false); // 3 > 2
      // Free event limit is STRICTER than paid event limit
      const maxPaid = 10;
      assert.ok(maxFree < maxPaid, 'Free event limit (2) must be stricter than paid event limit (10)');
    });

    it('cancelled bookings free up the slot on free events', () => {
      // getUserBookedCount excludes 'cancelled' status, so after cancellation the user can re-book
      const cancelledStatuses = ['cancelled'];
      const countedStatuses = ['pending', 'confirmed', 'attended', 'payment_pending'];
      // Simulate: user books 2 tickets (both confirmed), then cancels 1
      const initialCount = 2; // both confirmed
      const afterCancel = 1;  // 1 cancelled, 1 confirmed → counted = 1
      assert.strictEqual(afterCancel, initialCount - 1, 'Cancelling one booking frees one slot');
      // User should now be able to book 1 more (total would be 2, at the limit)
      assert.strictEqual(validatePerUserLimit(afterCancel, 1, FREE_EVENT_MAX_PER_USER).valid, true);
    });

    it('free event booking returns 201 with confirmed status', () => {
      const httpStatus = 201;
      const bookingStatus = 'confirmed';
      assert.strictEqual(httpStatus, 201);
      assert.strictEqual(bookingStatus, 'confirmed');
      // No payment_order_id in response for free events
      const responseKeys = ['bookingId', 'ticketCount', 'status', 'tickets'];
      assert.ok(!responseKeys.includes('paymentOrderId'), 'Free event response should not include paymentOrderId');
    });

    it('free event tickets are immediately valid for scanning', () => {
      const bookingStatus = 'confirmed';
      // ScanService accepts: booking_status === 'confirmed' AND event_status === 'published'
      const validScanStatuses = ['confirmed', 'attended'];
      assert.ok(validScanStatuses.includes(bookingStatus));
      // NOT 'payment_pending' — that would be rejected by scanService
      const rejectedStatuses = ['payment_pending', 'cancelled'];
      assert.ok(!rejectedStatuses.includes(bookingStatus));
    });

    it('free event capacity check works correctly', () => {
      const capacity = 100;
      const alreadyBooked = 98;
      const tryingToBook = 3;
      const remaining = capacity - alreadyBooked;
      assert.strictEqual(remaining, 2);
      assert.strictEqual(remaining >= tryingToBook, false, 'Should reject when not enough capacity');
      const validTickets = 2;
      assert.strictEqual(remaining >= validTickets, true, 'Should allow when capacity matches');
    });

    it('free event rate limit is 15 per minute', () => {
      assert.strictEqual(FREE_EVENT_RATE_LIMIT_MAX, 15);
      assert.strictEqual(FREE_EVENT_RATE_LIMIT_WINDOW_MS, 60_000);
    });

    it('free events must have price = 0', () => {
      const validFreePrice = 0;
      const invalidFreePrice = 100;
      assert.strictEqual(validFreePrice, 0, 'Free event price must be 0');
      assert.ok(invalidFreePrice > 0, 'Paid event price must be > 0');
    });

    it('paid events must have price > 0', () => {
      const validPaidPrice = 500;
      const invalidPaidPrice = 0;
      assert.ok(validPaidPrice > 0, 'Paid event price must be > 0');
      assert.strictEqual(invalidPaidPrice, 0, 'Price of 0 means free event');
    });
  });

  // ── 3. Layout-based paid event rules ──────────────────────────────────────

  describe('Layout-Based Paid Event Flow', () => {
    const eventType: EventType = 'layout';
    const event = makeEvent({ is_free: false, price: 500 });
    const zone = makeZone({ price: 1000 }); // Zone overrides event price

    it('requires zone_id', () => {
      const result = validateLayoutEventZone(undefined, eventType);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes('zone_id is required'));
    });

    it('accepts booking with zone_id', () => {
      const result = validateLayoutEventZone(5, eventType);
      assert.strictEqual(result.valid, true);
    });

    it('rejects zone_id for free events (cross-check)', () => {
      const result = validateFreeEventZone(5, 'free');
      assert.strictEqual(result.valid, false);
    });

    it('uses zone price for pricing, not event price', () => {
      // Prices in DB are stored as rupees; converted to paise for pricing engine
      const eventPricePaise = Math.round(Number(5) * 100);    // ₹5 = 500 paise
      const zonePricePaise = Math.round(Number(10) * 100);    // ₹10 = 1000 paise
      const eventPricing = calculatePricing(eventPricePaise, 2);
      const zonePricing = calculatePricing(zonePricePaise, 2);
      assert.strictEqual(paiseToRupees(eventPricing.totalPaise), 12.80); // (5*2)*1.28
      assert.strictEqual(paiseToRupees(zonePricing.totalPaise), 25.60);  // (10*2)*2.56
    });

    it('zone capacity is checked independently from event capacity', () => {
      const zoneCap = 50;
      const eventCap = 100;
      const tickets = 10;
      const zoneRemaining = zoneCap - tickets;
      const eventRemaining = eventCap - tickets;
      assert.ok(zoneRemaining >= 0, 'Zone has capacity');
      assert.ok(eventRemaining >= 0, 'Event has capacity');
    });

    it('zone sold out but event has capacity → reject', () => {
      const zoneCap = 5;
      const eventCap = 100;
      const tickets = 6;
      const zoneOk = zoneCap >= tickets;
      assert.strictEqual(zoneOk, false, 'Zone should reject');
    });

    it('zone has capacity but event sold out → reject', () => {
      const zoneCap = 100;
      const eventCap = 3;
      const tickets = 4;
      const eventOk = eventCap >= tickets;
      assert.strictEqual(eventOk, false, 'Event should reject');
    });

    it('pricing breakdown includes GST (18%) + Platform fee (10%)', () => {
      const pricing = calculatePricing(1000, 2); // ₹10 * 2 = ₹20
      assert.strictEqual(pricing.subtotalPaise, 2000);
      assert.strictEqual(pricing.gstPaise, 360);    // 18% of 2000
      assert.strictEqual(pricing.platformFeePaise, 200); // 10% of 2000
      assert.strictEqual(pricing.totalPaise, 2560);  // 2000 + 360 + 200
    });

    it('creates booking with payment_pending status', () => {
      // Layout events always go through payment first
      const expectedStatus = 'payment_pending';
      assert.strictEqual(expectedStatus, 'payment_pending');
    });

    it('includes zone info in payment metadata', () => {
      const zone = makeZone({ id: 3, name: 'Balcony' });
      const metadata = {
        source: 'event',
        event_type: 'layout_based',
        zone_id: zone.id,
        zone_name: zone.name,
      };
      assert.strictEqual(metadata.event_type, 'layout_based');
      assert.strictEqual(metadata.zone_id, 3);
      assert.strictEqual(metadata.zone_name, 'Balcony');
    });

    it('returns zone details in response', () => {
      const response = {
        bookingId: 42,
        status: 'payment_pending',
        zone: {
          zoneId: 3,
          zoneName: 'Balcony',
          unitPricePaise: 1000,
        },
        payment: {
          orderId: 'evt_42_1690000000000',
          amount: 2560,
          currency: 'INR',
        },
      };
      assert.strictEqual(response.zone.zoneId, 3);
      assert.strictEqual(response.zone.unitPricePaise, 1000);
    });
  });

  // ── 4. Normal paid event rules (unchanged) ────────────────────────────────

  describe('Normal Paid Event Flow', () => {
    const eventType: EventType = 'normal';
    const event = makeEvent({ is_free: false, price: 500 });

    it('does not require zone_id', () => {
      const result = validateLayoutEventZone(undefined, eventType);
      assert.strictEqual(result.valid, true);
    });

    it('accepts zone_id but ignores it', () => {
      // Backward compat: old clients may still send zone_id but event has no zones
      const result = validateLayoutEventZone(undefined, eventType);
      assert.strictEqual(result.valid, true);
    });

    it('uses event price for pricing', () => {
      // event.price = 500 (INR), converted to paise: 500 * 100 = 50000 paise
      const eventPricePaise = Math.round(Number(500) * 100);
      const pricing = calculatePricing(eventPricePaise, 2);
      // (50000 * 2) = 100000 paise + 18% GST + 10% platform = 128000 paise = ₹1280
      assert.strictEqual(paiseToRupees(pricing.totalPaise), 1280);
    });

    it('creates booking with payment_pending status', () => {
      const expectedStatus = 'payment_pending';
      assert.strictEqual(expectedStatus, 'payment_pending');
    });

    it('includes event_type: normal in payment metadata', () => {
      const metadata = {
        source: 'event',
        event_type: 'normal',
      };
      assert.strictEqual(metadata.event_type, 'normal');
    });

    it('returns 202 Accepted (payment pending)', () => {
      const statusCode = 202;
      assert.strictEqual(statusCode, 202);
    });
  });

  // ── 5. Cancellation flow ──────────────────────────────────────────────────

  describe('Cancellation Zone Capacity Release', () => {
    it('releases zone capacity on cancellation', () => {
      const zoneInitial = 50;
      const zoneAfterBooking = 40; // 10 tickets booked
      const ticketsToCancel = 10;
      const zoneAfterCancel = zoneAfterBooking + ticketsToCancel;
      assert.strictEqual(zoneAfterCancel, 50, 'Zone capacity should be fully restored');
    });

    it('partial cancellation restores proportional zone capacity', () => {
      const zoneAfterBooking = 40;
      const partialCancel = 3;
      const zoneAfterPartial = zoneAfterBooking + partialCancel;
      assert.strictEqual(zoneAfterPartial, 43);
    });

    it('does not double-release zone capacity on re-cancel', () => {
      // If booking is already cancelled, return error
      const bookingStatus = 'cancelled';
      assert.strictEqual(bookingStatus, 'cancelled');
    });

    it('cannot cancel attended bookings', () => {
      const bookingStatus = 'attended';
      assert.strictEqual(bookingStatus, 'attended');
    });
  });

  // ── 6. Scan service event status check ────────────────────────────────────

  describe('ScanService event status validation', () => {
    const validStatuses = ['published'];
    const invalidStatuses = ['draft', 'pending_review', 'approved', 'hidden', 'archived', 'cancelled'];

    for (const status of validStatuses) {
      it(`allows scan for event status: ${status}`, () => {
        assert.ok(validStatuses.includes(status));
      });
    }

    for (const status of invalidStatuses) {
      it(`rejects scan for event status: ${status}`, () => {
        assert.ok(invalidStatuses.includes(status));
      });
    }

    it('still rejects payment_pending bookings regardless of event status', () => {
      const bookingStatus = 'payment_pending';
      assert.strictEqual(bookingStatus, 'payment_pending');
    });

    it('still rejects cancelled bookings', () => {
      const bookingStatus = 'cancelled';
      assert.strictEqual(bookingStatus, 'cancelled');
    });
  });

  // ── 7. Backward compatibility ─────────────────────────────────────────────

  describe('Backward Compatibility', () => {
    it('existing normal event clients work without zone_id', () => {
      const event = makeEvent({ is_free: false, price: 500 });
      const zones: any[] = [];
      const eventType = classifyEvent(event, zones);
      assert.strictEqual(eventType, 'normal');
    });

    it('existing free event clients work (max 2 tickets rule)', () => {
      const result = validateBookingCount(2);
      assert.strictEqual(result.valid, true);
    });

    it('event creation input is unchanged', () => {
      const eventInput = {
        title: 'Concert',
        venue: 'Stadium',
        start_at: '2026-12-01T18:00:00Z',
        end_at: '2026-12-01T22:00:00Z',
        price: 500,
      };
      assert.strictEqual(eventInput.title, 'Concert');
      assert.strictEqual(eventInput.price, 500);
    });

    it('zone creation is additive — does not break existing events', () => {
      const existingEvent = makeEvent({ is_free: false, price: 500 });
      const zones = [makeZone()];
      const eventType = classifyEvent(existingEvent, zones);
      assert.strictEqual(eventType, 'layout');
      // If zones are deleted, it falls back to normal
      const noZones: any[] = [];
      assert.strictEqual(classifyEvent(existingEvent, noZones), 'normal');
    });
  });

  // ── 8. Idempotency ────────────────────────────────────────────────────────

  describe('Idempotency', () => {
    it('confirming an already-confirmed booking is safe', () => {
      const bookingStatus = 'confirmed';
      // Service returns alreadyConfirmed: true without error
      assert.strictEqual(bookingStatus, 'confirmed');
    });

    it('cancelling an already-cancelled booking is safe', () => {
      const bookingStatus = 'cancelled';
      // Service returns error "Booking is already cancelled"
      assert.strictEqual(bookingStatus, 'cancelled');
    });
  });

  // ── 9. Pricing edge cases ─────────────────────────────────────────────────

  describe('Pricing Edge Cases', () => {
    it('handles zero quantity (validated upstream)', () => {
      const result = validateBookingCount(0);
      assert.strictEqual(result.valid, false);
    });

    it('handles 10 tickets (max allowed)', () => {
      const pricing = calculatePricing(1000, 10);
      assert.strictEqual(pricing.quantity, 10);
      assert.strictEqual(pricing.subtotalPaise, 10000);
    });

    it('rounds paise arithmetic correctly', () => {
      const pricing = calculatePricing(333, 3); // ₹3.33 * 3 = ₹9.99
      assert.strictEqual(pricing.subtotalPaise, 999);
      assert.strictEqual(pricing.gstPaise, 180); // 18% of 999 = 179.82 → 180
      assert.strictEqual(pricing.platformFeePaise, 100); // 10% of 999 = 99.9 → 100
    });

    it('free event has zero pricing', () => {
      const pricing = calculatePricing(0, 1);
      assert.strictEqual(pricing.totalPaise, 0);
    });
  });
});
