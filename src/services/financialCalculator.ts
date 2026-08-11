/**
 * FinancialCalculator — exact integer (paise) arithmetic for all financial computations.
 *
 * Principles:
 *  1. All monetary values in paise (integer) — never floating-point for money.
 *  2. Percentages as basis points: 18% = 1800, 5% = 500.
 *  3. Pure functions, no side effects, no DB calls.
 *  4. configSnapshot is Record<string, unknown> to match DB JSONB storage.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const BPS_DIVISOR = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function roundPaise(paise: number): number {
  return Math.round(paise);
}

export function bpsToPaise(amountPaise: number, bps: number): number {
  return roundPaise((amountPaise * bps) / BPS_DIVISOR);
}

export function flatPaise(valuePaise: number | null | undefined): number {
  return valuePaise ?? 0;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${rupees}.${remainder.toString().padStart(2, '0')}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfigSnapshot = Record<string, unknown>;

export interface BookingCalculationInput {
  gross_amount_paise: number;
  coupon_discount_paise?: number;
  cancellation_fee_paise?: number;
  config: ConfigSnapshot;
}

export interface BookingFinancialBreakdown {
  gross_amount_paise: number;
  currency: string;
  platform_fee_paise: number;
  gst_on_platform_fee_paise: number;
  commission_paise: number;
  tds_paise: number;
  cancellation_fee_paise: number;
  coupon_discount_paise: number;
  net_payable_to_business_paise: number;
  total_customer_charged_paise: number;
  config_snapshot: ConfigSnapshot;
}

export interface RefundCalculationInput {
  originalBreakdown: BookingFinancialBreakdown;
  refund_percentage: number;
}

export interface RefundFinancialBreakdown {
  refund_amount_paise: number;
  platform_fee_refund_paise: number;
  gst_refund_paise: number;
  commission_reversal_paise: number;
  business_debit_paise: number;
  config_snapshot: ConfigSnapshot;
}

export interface SettlementCalculationInput {
  booking_id: number;
  breakdown: BookingFinancialBreakdown;
  adjustment_paise?: number;
}

export interface SettlementCalculation {
  booking_id: number;
  gross_amount_paise: number;
  platform_fee_paise: number;
  gst_paise: number;
  commission_paise: number;
  tds_paise: number;
  net_settlement_paise: number;
  adjustment_paise: number;
  final_payout_paise: number;
  config_snapshot: ConfigSnapshot;
}

// ── Core Calculations ─────────────────────────────────────────────────────────

function bpsValue(snapshot: ConfigSnapshot, key: string, fallback: number): number {
  const v = snapshot[key];
  return typeof v === 'number' ? v : fallback;
}

export function calculateBookingFinancials(input: BookingCalculationInput): BookingFinancialBreakdown {
  const {
    gross_amount_paise,
    coupon_discount_paise = 0,
    cancellation_fee_paise = 0,
    config,
  } = input;

  const platformFeePaise = bpsToPaise(gross_amount_paise, bpsValue(config, 'platform_fee_bps', 500));
  const gstOnPlatformFeePaise = bpsToPaise(platformFeePaise, bpsValue(config, 'gst_bps', 1800));
  const commissionPaise = bpsToPaise(gross_amount_paise, bpsValue(config, 'commission_bps', 1000));
  const tdsPaise = bpsToPaise(commissionPaise, bpsValue(config, 'tds_bps', 0));

  const totalCustomerChargedPaise = gross_amount_paise
    + platformFeePaise + gstOnPlatformFeePaise - coupon_discount_paise;

  const netPayableToBusinessPaise = gross_amount_paise
    - commissionPaise - tdsPaise - coupon_discount_paise + cancellation_fee_paise;

  return {
    gross_amount_paise,
    currency: 'INR',
    platform_fee_paise: platformFeePaise,
    gst_on_platform_fee_paise: gstOnPlatformFeePaise,
    commission_paise: commissionPaise,
    tds_paise: tdsPaise,
    cancellation_fee_paise,
    coupon_discount_paise,
    net_payable_to_business_paise: netPayableToBusinessPaise,
    total_customer_charged_paise: totalCustomerChargedPaise,
    config_snapshot: { ...config },
  };
}

export function calculateRefundFinancials(input: RefundCalculationInput): RefundFinancialBreakdown {
  const { originalBreakdown, refund_percentage } = input;
  const fraction = refund_percentage / 100;

  const refundGross = roundPaise(originalBreakdown.gross_amount_paise * fraction);
  const refundPlatformFee = roundPaise(originalBreakdown.platform_fee_paise * fraction);
  const refundGst = roundPaise(originalBreakdown.gst_on_platform_fee_paise * fraction);
  const refundCommission = roundPaise(originalBreakdown.commission_paise * fraction);
  const refundCoupon = roundPaise(originalBreakdown.coupon_discount_paise * fraction);
  const refundCancellation = roundPaise(originalBreakdown.cancellation_fee_paise * fraction);

  const refundAmountPaise = refundGross + refundPlatformFee + refundGst - refundCoupon;
  const businessDebitPaise = refundGross - refundCommission - refundCoupon + refundCancellation;

  return {
    refund_amount_paise: refundAmountPaise,
    platform_fee_refund_paise: refundPlatformFee,
    gst_refund_paise: refundGst,
    commission_reversal_paise: refundCommission,
    business_debit_paise: businessDebitPaise,
    config_snapshot: { ...originalBreakdown.config_snapshot },
  };
}

export function calculateSettlement(input: SettlementCalculationInput): SettlementCalculation {
  const { booking_id, breakdown, adjustment_paise = 0 } = input;

  return {
    booking_id,
    gross_amount_paise: breakdown.gross_amount_paise,
    platform_fee_paise: breakdown.platform_fee_paise,
    gst_paise: breakdown.gst_on_platform_fee_paise,
    commission_paise: breakdown.commission_paise,
    tds_paise: breakdown.tds_paise,
    net_settlement_paise: breakdown.net_payable_to_business_paise,
    adjustment_paise,
    final_payout_paise: breakdown.net_payable_to_business_paise + adjustment_paise,
    config_snapshot: { ...breakdown.config_snapshot },
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validatePaiseAmount(paise: number, fieldName = 'amount'): void {
  if (!Number.isInteger(paise)) throw new Error(`${fieldName} must be integer paise, got ${paise}`);
  if (paise < 0) throw new Error(`${fieldName} must be non-negative, got ${paise}`);
  if (paise > 1_000_000_000_000) throw new Error(`${fieldName} exceeds INR 1 crore: ${paise} paise`);
}

export function validateBps(bps?: number, fieldName = 'rate'): void {
  if (bps === undefined) throw new Error(`${fieldName} exceeds 100%`);
  if (!Number.isInteger(bps)) throw new Error(`${fieldName} must be integer bps, got ${bps}`);
  if (bps < 0) throw new Error(`${fieldName} must be non-negative, got ${bps}`);
  if (bps > 10000) throw new Error(`${fieldName} exceeds 100%: ${bps}`);
}

export function verifyLedgerBalance(entries: Array<{ amount_paise: number; direction: 'debit' | 'credit' }>): boolean {
  let total = 0;
  for (const entry of entries) {
    total += entry.direction === 'debit' ? entry.amount_paise : -entry.amount_paise;
  }
  return total === 0;
}
