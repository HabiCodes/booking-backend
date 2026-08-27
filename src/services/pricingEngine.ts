/**
 * Universal PricingEngine — authoritative price calculation for all booking domains.
 *
 * Architecture:
 *   PricingRequest
 *       ↓
 *   PricingEngine.calculate()
 *       ↓
 *   PricingBreakdown
 *
 * Principles:
 *   1. All monetary values in integer paise — never floating-point for money.
 *   2. Backend is the ONLY authority for pricing — never trust client values.
 *   3. Domain-specific rules are configuration-driven but enforced centrally.
 *   4. Financial snapshot is preserved for historical bookings.
 *   5. Deterministic rounding — same inputs always produce same output.
 *
 * Domain rules (FINAL — do not change without business approval):
 *
 *   EVENT:
 *     GST 18% (9% CGST + 9% SGST) on base price
 *     Platform fee = 10% of GST-inclusive amount
 *     Platform fee added AFTER GST
 *
 *   MOVIE_ONLINE:
 *     GST 18% (9% CGST + 9% SGST) on base price
 *     Platform fee = ₹20 per ticket (flat)
 *     Platform fee added AFTER GST
 *
 *   MOVIE_MANAGER:
 *     GST 18% (9% CGST + 9% SGST) on base price
 *     Platform fee = 2% of base ticket price
 *     Platform fee added AFTER GST
 *
 *   TURF:
 *     GST 18% (9% CGST + 9% SGST) on base price
 *     Platform fee = ₹50 per booking (flat)
 *     Platform fee added AFTER GST
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** 18% GST = 1800 basis points */
const GST_BPS = 1800;
/** 9% CGST = 900 basis points */
const CGST_BPS = 900;
/** 9% SGST = 900 basis points */
const SGST_BPS = 900;
/** Basis points divisor (10000 = 100%) */
const BPS_DIVISOR = 10_000;
/** Paise per rupee */
const PAISE_PER_RUPEE = 100;

// ── Types ──────────────────────────────────────────────────────────────────────

export type BookingDomain = 'event' | 'movie_online' | 'movie_manager' | 'turf';

export interface PricingRequest {
  /** Booking domain — determines which pricing rules apply */
  domain: BookingDomain;
  /** Base unit price in paise (authoritative — from backend, never from client) */
  unitPricePaise: number;
  /** Number of tickets/units */
  quantity: number;
  /** ISO currency code (default INR) */
  currency?: string;
  /** Optional discount in paise (applied to base amount before GST) */
  discountPaise?: number;
  /** Pricing rule version for audit/snapshot */
  pricingRuleVersion?: string;
  /** Server-authoritative booking channel (for movie domain) */
  bookingChannel?: 'online' | 'manager' | 'admin';
}

export interface PricingBreakdown {
  /** Domain that produced this breakdown */
  domain: BookingDomain;
  /** Base unit price per ticket/unit in paise */
  unitPricePaise: number;
  /** Number of tickets/units */
  quantity: number;
  /** Subtotal = unitPricePaise * quantity in paise */
  subtotalPaise: number;
  /** Discount applied in paise */
  discountPaise: number;
  /** Taxable amount = subtotal - discount in paise */
  taxableAmountPaise: number;
  /** CGST amount in paise */
  cgstPaise: number;
  /** SGST amount in paise */
  sgstPaise: number;
  /** Total GST = CGST + SGST in paise */
  gstTotalPaise: number;
  /** GST-inclusive amount = taxableAmountPaise + gstTotalPaise in paise */
  gstInclusivePaise: number;
  /** Platform fee in paise */
  platformFeePaise: number;
  /** FINAL total = gstInclusivePaise + platformFeePaise in paise */
  totalPaise: number;
  /** Currency code */
  currency: string;
  /** Pricing rule version string */
  pricingRuleVersion: string;
  /** Calculation timestamp (ISO string) */
  calculatedAt: string;
  /** Breakdown by per-ticket (for itemized display) */
  perUnitBreakdown: PerUnitPricing;
}

export interface PerUnitPricing {
  basePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  gstTotalPaise: number;
  gstInclusivePaise: number;
  platformFeePaise: number;
  totalPaise: number;
}

export interface FinancialSnapshot {
  /** Domain */
  domain: string;
  /** Booking channel */
  bookingChannel: string;
  /** Base unit price in paise */
  unitPricePaise: number;
  /** Quantity */
  quantity: number;
  /** Subtotal in paise */
  subtotalPaise: number;
  /** Discount in paise */
  discountPaise: number;
  /** Taxable amount in paise */
  taxableAmountPaise: number;
  /** CGST in paise */
  cgstPaise: number;
  /** SGST in paise */
  sgstPaise: number;
  /** Total GST in paise */
  gstTotalPaise: number;
  /** GST-inclusive in paise */
  gstInclusivePaise: number;
  /** Platform fee in paise */
  platformFeePaise: number;
  /** Final total in paise */
  totalPaise: number;
  /** Currency */
  currency: string;
  /** Pricing rule version */
  pricingRuleVersion: string;
  /** Calculation timestamp */
  calculatedAt: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function roundPaise(value: number): number {
  return Math.round(value);
}

function bpsToPaise(amountPaise: number, bps: number): number {
  return roundPaise((amountPaise * bps) / BPS_DIVISOR);
}

function validateNonNegativePaise(value: number, fieldName: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`PricingEngine: ${fieldName} must be integer paise, got ${value}`);
  }
  if (value < 0) {
    throw new Error(`PricingEngine: ${fieldName} must be non-negative, got ${value}`);
  }
}

// ── Core Engine ────────────────────────────────────────────────────────────────

export class PricingEngine {

  /**
   * Calculate the authoritative pricing breakdown for a booking.
   *
   * This is the ONLY function that should compute prices for any booking domain.
   * All callers must pass backend-validated inputs — never client-provided prices.
   *
   * @throws Error if inputs are invalid or pricing rules are violated
   */
  calculate(request: PricingRequest): PricingBreakdown {
    const {
      domain,
      unitPricePaise,
      quantity,
      currency = 'INR',
      discountPaise = 0,
      pricingRuleVersion = 'v1',
    } = request;

    // ── Validate inputs ──────────────────────────────────────────────────────
    validateNonNegativePaise(unitPricePaise, 'unitPricePaise');
    if (quantity < 1) {
      throw new Error(`PricingEngine: quantity must be >= 1, got ${quantity}`);
    }
    if (discountPaise < 0) {
      throw new Error(`PricingEngine: discountPaise must be non-negative, got ${discountPaise}`);
    }

    // ── Compute base amounts ─────────────────────────────────────────────────
    const subtotalPaise = unitPricePaise * quantity;
    const taxableAmountPaise = Math.max(0, subtotalPaise - discountPaise);

    // ── Compute GST (18% = 9% CGST + 9% SGST) ───────────────────────────────
    const cgstPaise = bpsToPaise(taxableAmountPaise, CGST_BPS);
    const sgstPaise = bpsToPaise(taxableAmountPaise, SGST_BPS);
    const gstTotalPaise = cgstPaise + sgstPaise;
    const gstInclusivePaise = taxableAmountPaise + gstTotalPaise;

    // ── Compute platform fee (domain-specific) ───────────────────────────────
    const platformFeePaise = this.calculatePlatformFee(domain, unitPricePaise, quantity, request);

    // ── Compute final total ──────────────────────────────────────────────────
    const totalPaise = gstInclusivePaise + platformFeePaise;

    // ── Per-unit breakdown (for itemized display) ─────────────────────────────
    const perUnitBreakdown: PerUnitPricing = {
      basePaise: unitPricePaise,
      cgstPaise: roundPaise(cgstPaise / quantity),
      sgstPaise: roundPaise(sgstPaise / quantity),
      gstTotalPaise: roundPaise(gstTotalPaise / quantity),
      gstInclusivePaise: roundPaise(gstInclusivePaise / quantity),
      platformFeePaise: roundPaise(platformFeePaise / quantity),
      totalPaise: roundPaise(totalPaise / quantity),
    };

    return {
      domain,
      unitPricePaise,
      quantity,
      subtotalPaise,
      discountPaise,
      taxableAmountPaise,
      cgstPaise,
      sgstPaise,
      gstTotalPaise,
      gstInclusivePaise,
      platformFeePaise,
      totalPaise,
      currency,
      pricingRuleVersion,
      calculatedAt: new Date().toISOString(),
      perUnitBreakdown,
    };
  }

  /**
   * Calculate platform fee based on domain-specific rules.
   */
  private calculatePlatformFee(
    domain: string,
    unitPricePaise: number,
    quantity: number,
    request: PricingRequest
  ): number {
    switch (domain) {
      case 'event':
        // Platform fee = 10% of base ticket price (before GST)
        // 10% = 1000 basis points
        return bpsToPaise(unitPricePaise * quantity, 1000);

      case 'movie_online':
        // Platform fee = ₹20 per ticket (flat)
        // 20 * 100 = 2000 paise per ticket
        return 2000 * quantity;

      case 'movie_manager':
        // Platform fee = 2% of base ticket price
        // 2% = 200 basis points
        const baseTotalPaise = unitPricePaise * quantity;
        return bpsToPaise(baseTotalPaise, 200);

      case 'turf':
        // Platform fee = ₹50 per booking (flat)
        return 50 * PAISE_PER_RUPEE;

      default:
        throw new Error(`PricingEngine: unknown domain "${domain}"`);
    }
  }

  /**
   * Convert a PricingBreakdown to a FinancialSnapshot for DB storage.
   * This preserves the exact pricing at the time of booking.
   */
  static toSnapshot(breakdown: PricingBreakdown, bookingChannel: string): FinancialSnapshot {
    return {
      domain: breakdown.domain,
      bookingChannel,
      unitPricePaise: breakdown.unitPricePaise,
      quantity: breakdown.quantity,
      subtotalPaise: breakdown.subtotalPaise,
      discountPaise: breakdown.discountPaise,
      taxableAmountPaise: breakdown.taxableAmountPaise,
      cgstPaise: breakdown.cgstPaise,
      sgstPaise: breakdown.sgstPaise,
      gstTotalPaise: breakdown.gstTotalPaise,
      gstInclusivePaise: breakdown.gstInclusivePaise,
      platformFeePaise: breakdown.platformFeePaise,
      totalPaise: breakdown.totalPaise,
      currency: breakdown.currency,
      pricingRuleVersion: breakdown.pricingRuleVersion,
      calculatedAt: breakdown.calculatedAt,
    };
  }

  /**
   * Verify that a payment amount matches the expected pricing breakdown.
   * Returns true if they match, throws if they don't.
   */
  static verifyPaymentAmount(expected: PricingBreakdown, paidAmountPaise: number): void {
    if (expected.totalPaise !== paidAmountPaise) {
      throw new Error(
        `PricingEngine: Payment amount mismatch. ` +
        `Expected ${expected.totalPaise} paise (₹${(expected.totalPaise / 100).toFixed(2)}), ` +
        `got ${paidAmountPaise} paise (₹${(paidAmountPaise / 100).toFixed(2)}). ` +
        `Domain: ${expected.domain}, quantity: ${expected.quantity}, unitPrice: ${expected.unitPricePaise} paise.`
      );
    }
  }
}

export const pricingEngine = new PricingEngine();
