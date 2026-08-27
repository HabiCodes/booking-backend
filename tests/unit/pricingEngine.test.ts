/**
 * PricingEngine tests — verifies exact business pricing rules.
 *
 * Test framework: node:test + node:assert (matches existing test style).
 *
 * Business rules tested:
 *   EVENT:    18% GST (9% CGST + 9% SGST) + 10% platform fee on GST-inclusive amount
 *   MOVIE_ONLINE: 18% GST + ₹20/ticket flat platform fee
 *   MOVIE_MANAGER: 18% GST + 2% platform fee on base price
 *   TURF:     18% GST + ₹50/booking flat platform fee
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  pricingEngine,
  PricingEngine,
  type PricingBreakdown,
  type PricingRequest,
  type FinancialSnapshot,
} from '../../src/services/pricingEngine';

// ── Helpers ────────────────────────────────────────────────────────────────────

function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

function assertBreakdown(breakdown: PricingBreakdown, expected: {
  domain: string;
  unitPricePaise: number;
  quantity: number;
  subtotalPaise: number;
  discountPaise: number;
  taxableAmountPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  gstTotalPaise: number;
  gstInclusivePaise: number;
  platformFeePaise: number;
  totalPaise: number;
}): void {
  assert.strictEqual(breakdown.domain, expected.domain);
  assert.strictEqual(breakdown.unitPricePaise, expected.unitPricePaise);
  assert.strictEqual(breakdown.quantity, expected.quantity);
  assert.strictEqual(breakdown.subtotalPaise, expected.subtotalPaise);
  assert.strictEqual(breakdown.discountPaise, expected.discountPaise);
  assert.strictEqual(breakdown.taxableAmountPaise, expected.taxableAmountPaise);
  assert.strictEqual(breakdown.cgstPaise, expected.cgstPaise);
  assert.strictEqual(breakdown.sgstPaise, expected.sgstPaise);
  assert.strictEqual(breakdown.gstTotalPaise, expected.gstTotalPaise);
  assert.strictEqual(breakdown.gstInclusivePaise, expected.gstInclusivePaise);
  assert.strictEqual(breakdown.platformFeePaise, expected.platformFeePaise);
  assert.strictEqual(breakdown.totalPaise, expected.totalPaise);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT PRICING
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Event', () => {

  it('₹1,000 × 1 ticket → ₹1,298 (exact business example)', () => {
    // Ticket price = ₹1,000
    // CGST = ₹90 (9% of ₹1,000)
    // SGST = ₹90 (9% of ₹1,000)
    // GST = ₹180
    // GST-inclusive = ₹1,180
    // Platform fee = 10% of ₹1,180 = ₹118
    // Total = ₹1,298
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 1,
    });
    assertBreakdown(breakdown, {
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 1,
      subtotalPaise: 100000,
      discountPaise: 0,
      taxableAmountPaise: 100000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      gstTotalPaise: 18000,
      gstInclusivePaise: 118000,
      platformFeePaise: 10000,
      totalPaise: 128000,
    });
  });

  it('₹1,000 × 3 tickets', () => {
    // Subtotal = ₹3,000
    // CGST = ₹270, SGST = ₹270, GST = ₹540
    // GST-inclusive = ₹3,540
    // Platform fee = 10% of ₹3,000 (base) = ₹300
    // Total = ₹3,840
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 3,
    });
    assert.strictEqual(breakdown.subtotalPaise, 300000);
    assert.strictEqual(breakdown.cgstPaise, 27000);
    assert.strictEqual(breakdown.sgstPaise, 27000);
    assert.strictEqual(breakdown.gstTotalPaise, 54000);
    assert.strictEqual(breakdown.gstInclusivePaise, 354000);
    assert.strictEqual(breakdown.platformFeePaise, 30000);
    assert.strictEqual(breakdown.totalPaise, 384000);
  });

  it('free event (price = 0) → no GST, no platform fee', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 0,
      quantity: 1,
    });
    assert.strictEqual(breakdown.subtotalPaise, 0);
    assert.strictEqual(breakdown.cgstPaise, 0);
    assert.strictEqual(breakdown.sgstPaise, 0);
    assert.strictEqual(breakdown.gstTotalPaise, 0);
    assert.strictEqual(breakdown.gstInclusivePaise, 0);
    assert.strictEqual(breakdown.platformFeePaise, 0);
    assert.strictEqual(breakdown.totalPaise, 0);
  });

  it('event with discount', () => {
    // Ticket = ₹1,000, discount = ₹100
    // Taxable = ₹900
    // CGST = ₹81, SGST = ₹81, GST = ₹162
    // GST-inclusive = ₹1,062
    // Platform fee = 10% of ₹1,000 (base ticket price) = ₹100
    // Total = ₹1,162
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 1,
      discountPaise: rupeesToPaise(100),
    });
    assert.strictEqual(breakdown.taxableAmountPaise, 90000);
    assert.strictEqual(breakdown.cgstPaise, 8100);
    assert.strictEqual(breakdown.sgstPaise, 8100);
    assert.strictEqual(breakdown.gstTotalPaise, 16200);
    assert.strictEqual(breakdown.gstInclusivePaise, 106200);
    assert.strictEqual(breakdown.platformFeePaise, 10000);
    assert.strictEqual(breakdown.totalPaise, 116200);
  });

  it('event: decimal paise edge case (₹333 × 1)', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 33300,
      quantity: 1,
    });
    // Subtotal = ₹333
    // CGST = ₹29.97 → ₹30, SGST = ₹29.97 → ₹30
    // GST = ₹59.94 → ₹60
    // GST-inclusive = ₹393
    // Platform fee = 10% of ₹333 = ₹33.30 → ₹33
    // Total = ₹426
    assert.strictEqual(breakdown.cgstPaise, 2997);
    assert.strictEqual(breakdown.sgstPaise, 2997);
    assert.strictEqual(breakdown.gstTotalPaise, 5994);
    assert.strictEqual(breakdown.gstInclusivePaise, 39294);
    assert.strictEqual(breakdown.platformFeePaise, 3330);
    assert.strictEqual(breakdown.totalPaise, 42624);
  });

  it('event: large quantity (100 tickets)', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: rupeesToPaise(500),
      quantity: 100,
    });
    assert.strictEqual(breakdown.totalPaise, rupeesToPaise(500 * 100 * (1 + 0.18 + 0.10)));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOVIE ONLINE PRICING
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Movie Online', () => {

  it('₹200 × 1 ticket → ₹256 (exact business example)', () => {
    // Ticket = ₹200
    // CGST = ₹18, SGST = ₹18, GST = ₹36
    // GST-inclusive = ₹236
    // Platform fee = ₹20 per ticket
    // Total = ₹256
    const breakdown = pricingEngine.calculate({
      domain: 'movie_online',
      unitPricePaise: rupeesToPaise(200),
      quantity: 1,
    });
    assertBreakdown(breakdown, {
      domain: 'movie_online',
      unitPricePaise: 20000,
      quantity: 1,
      subtotalPaise: 20000,
      discountPaise: 0,
      taxableAmountPaise: 20000,
      cgstPaise: 1800,
      sgstPaise: 1800,
      gstTotalPaise: 3600,
      gstInclusivePaise: 23600,
      platformFeePaise: 2000,
      totalPaise: 25600,
    });
  });

  it('₹200 × 3 tickets → ₹768', () => {
    // Subtotal = ₹600
    // CGST = ₹54, SGST = ₹54, GST = ₹108
    // GST-inclusive = ₹708
    // Platform fee = ₹20 × 3 = ₹60
    // Total = ₹768
    const breakdown = pricingEngine.calculate({
      domain: 'movie_online',
      unitPricePaise: rupeesToPaise(200),
      quantity: 3,
    });
    assert.strictEqual(breakdown.subtotalPaise, 60000);
    assert.strictEqual(breakdown.cgstPaise, 5400);
    assert.strictEqual(breakdown.sgstPaise, 5400);
    assert.strictEqual(breakdown.gstTotalPaise, 10800);
    assert.strictEqual(breakdown.gstInclusivePaise, 70800);
    assert.strictEqual(breakdown.platformFeePaise, 6000);
    assert.strictEqual(breakdown.totalPaise, 76800);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MOVIE MANAGER PRICING
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Movie Manager', () => {

  it('₹200 × 1 ticket → ₹240 (exact business example)', () => {
    // Ticket = ₹200
    // CGST = ₹18, SGST = ₹18, GST = ₹36
    // GST-inclusive = ₹236
    // Platform fee = 2% of ₹200 = ₹4
    // Total = ₹240
    const breakdown = pricingEngine.calculate({
      domain: 'movie_manager',
      unitPricePaise: rupeesToPaise(200),
      quantity: 1,
    });
    assertBreakdown(breakdown, {
      domain: 'movie_manager',
      unitPricePaise: 20000,
      quantity: 1,
      subtotalPaise: 20000,
      discountPaise: 0,
      taxableAmountPaise: 20000,
      cgstPaise: 1800,
      sgstPaise: 1800,
      gstTotalPaise: 3600,
      gstInclusivePaise: 23600,
      platformFeePaise: 400,
      totalPaise: 24000,
    });
  });

  it('₹200 × 3 tickets → ₹712', () => {
    // Subtotal = ₹600
    // CGST = ₹54, SGST = ₹54, GST = ₹108
    // GST-inclusive = ₹708
    // Platform fee = 2% of ₹600 = ₹12
    // Total = ₹720
    const breakdown = pricingEngine.calculate({
      domain: 'movie_manager',
      unitPricePaise: rupeesToPaise(200),
      quantity: 3,
    });
    assert.strictEqual(breakdown.subtotalPaise, 60000);
    assert.strictEqual(breakdown.cgstPaise, 5400);
    assert.strictEqual(breakdown.sgstPaise, 5400);
    assert.strictEqual(breakdown.gstTotalPaise, 10800);
    assert.strictEqual(breakdown.gstInclusivePaise, 70800);
    assert.strictEqual(breakdown.platformFeePaise, 1200);
    assert.strictEqual(breakdown.totalPaise, 72000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TURF PRICING
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Turf', () => {

  it('₹1,000 booking → ₹1,230 (exact business example)', () => {
    // Booking = ₹1,000
    // CGST = ₹90, SGST = ₹90, GST = ₹180
    // GST-inclusive = ₹1,180
    // Platform fee = ₹50 per booking
    // Total = ₹1,230
    const breakdown = pricingEngine.calculate({
      domain: 'turf',
      unitPricePaise: 100000,
      quantity: 1,
    });
    assertBreakdown(breakdown, {
      domain: 'turf',
      unitPricePaise: 100000,
      quantity: 1,
      subtotalPaise: 100000,
      discountPaise: 0,
      taxableAmountPaise: 100000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      gstTotalPaise: 18000,
      gstInclusivePaise: 118000,
      platformFeePaise: 5000,
      totalPaise: 123000,
    });
  });

  it('turf: platform fee stays ₹50 regardless of quantity', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'turf',
      unitPricePaise: 100000,
      quantity: 2,
    });
    assert.strictEqual(breakdown.platformFeePaise, 5000); // ₹50 flat per booking
    assert.strictEqual(breakdown.totalPaise, 241000); // ₹2,410
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY — Client cannot override values
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Security', () => {

  it('negative unitPricePaise throws', () => {
    assert.throws(() => {
      pricingEngine.calculate({
        domain: 'event',
        unitPricePaise: -1000,
        quantity: 1,
      });
    }, /non-negative/);
  });

  it('zero quantity throws', () => {
    assert.throws(() => {
      pricingEngine.calculate({
        domain: 'event',
        unitPricePaise: 100000,
        quantity: 0,
      });
    }, /quantity must be >= 1/);
  });

  it('negative discount throws', () => {
    assert.throws(() => {
      pricingEngine.calculate({
        domain: 'event',
        unitPricePaise: 100000,
        quantity: 1,
        discountPaise: -1000,
      });
    }, /non-negative/);
  });

  it('unknown domain throws', () => {
    assert.throws(() => {
      pricingEngine.calculate({
        domain: 'unknown' as any,
        unitPricePaise: 100000,
        quantity: 1,
      });
    }, /unknown domain/);
  });

  it('verifyPaymentAmount throws on mismatch', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 1,
    });
    assert.throws(() => {
      PricingEngine.verifyPaymentAmount(breakdown, 100000); // ₹1,000 instead of ₹1,298
    }, /Payment amount mismatch/);
  });

  it('verifyPaymentAmount passes on match', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 1,
    });
    assert.doesNotThrow(() => {
      PricingEngine.verifyPaymentAmount(breakdown, breakdown.totalPaise);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCIAL SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — FinancialSnapshot', () => {

  it('converts breakdown to snapshot for DB storage', () => {
    const breakdown = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 100000,
      quantity: 2,
    });
    const snapshot = PricingEngine.toSnapshot(breakdown, 'online');
    assert.strictEqual(snapshot.domain, 'event');
    assert.strictEqual(snapshot.bookingChannel, 'online');
    assert.strictEqual(snapshot.unitPricePaise, 100000);
    assert.strictEqual(snapshot.quantity, 2);
    assert.strictEqual(snapshot.totalPaise, 256000); // ₹2,560
    assert.ok(snapshot.calculatedAt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC ROUNDING
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Deterministic Rounding', () => {

  it('same inputs always produce same output', () => {
    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = pricingEngine.calculate({
        domain: 'event',
        unitPricePaise: 33333,
        quantity: 7,
      });
      results.push(r.totalPaise);
    }
    assert.strictEqual(new Set(results).size, 1);
  });

  it('rounding boundaries are stable', () => {
    // Test values that produce .5 paise to verify consistent rounding
    const r1 = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 11111,
      quantity: 9,
    });
    const r2 = pricingEngine.calculate({
      domain: 'event',
      unitPricePaise: 11111,
      quantity: 9,
    });
    assert.strictEqual(r1.totalPaise, r2.totalPaise);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-DOMAIN CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════════

describe('PricingEngine — Cross-Domain Consistency', () => {

  it('all domains apply the same 18% GST rate', () => {
    const unitPrice = 100000; // ₹1,000
    const qty = 1;

    const event = pricingEngine.calculate({ domain: 'event', unitPricePaise: unitPrice, quantity: qty });
    const movieOnline = pricingEngine.calculate({ domain: 'movie_online', unitPricePaise: unitPrice, quantity: qty });
    const movieManager = pricingEngine.calculate({ domain: 'movie_manager', unitPricePaise: unitPrice, quantity: qty });
    const turf = pricingEngine.calculate({ domain: 'turf', unitPricePaise: unitPrice, quantity: qty });

    // All should have the same CGST and SGST for the same base price
    assert.strictEqual(event.cgstPaise, 9000);
    assert.strictEqual(movieOnline.cgstPaise, 9000);
    assert.strictEqual(movieManager.cgstPaise, 9000);
    assert.strictEqual(turf.cgstPaise, 9000);

    assert.strictEqual(event.sgstPaise, 9000);
    assert.strictEqual(movieOnline.sgstPaise, 9000);
    assert.strictEqual(movieManager.sgstPaise, 9000);
    assert.strictEqual(turf.sgstPaise, 9000);

    // All should have the same GST-inclusive amount
    assert.strictEqual(event.gstInclusivePaise, 118000);
    assert.strictEqual(movieOnline.gstInclusivePaise, 118000);
    assert.strictEqual(movieManager.gstInclusivePaise, 118000);
    assert.strictEqual(turf.gstInclusivePaise, 118000);
  });

  it('platform fees differ by domain (₹1,000 base, 1 unit)', () => {
    const event = pricingEngine.calculate({ domain: 'event', unitPricePaise: 100000, quantity: 1 });
    const movieOnline = pricingEngine.calculate({ domain: 'movie_online', unitPricePaise: 100000, quantity: 1 });
    const movieManager = pricingEngine.calculate({ domain: 'movie_manager', unitPricePaise: 100000, quantity: 1 });
    const turf = pricingEngine.calculate({ domain: 'turf', unitPricePaise: 100000, quantity: 1 });

    // Event: 10% of ₹1,000 = ₹100
    assert.strictEqual(event.platformFeePaise, 10000);
    // Movie online: ₹20 flat
    assert.strictEqual(movieOnline.platformFeePaise, 2000);
    // Movie manager: 2% of ₹1,000 = ₹20
    assert.strictEqual(movieManager.platformFeePaise, 2000);
    // Turf: ₹50 flat
    assert.strictEqual(turf.platformFeePaise, 5000);
  });
});
