"use strict";
/**
 * FinancialCalculator — exact integer (paise) arithmetic for all financial computations.
 *
 * Principles:
 *  1. All monetary values in paise (integer) — never floating-point for money.
 *  2. Percentages as basis points: 18% = 1800, 5% = 500.
 *  3. Pure functions, no side effects, no DB calls.
 *  4. configSnapshot is Record<string, unknown> to match DB JSONB storage.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundPaise = roundPaise;
exports.bpsToPaise = bpsToPaise;
exports.flatPaise = flatPaise;
exports.rupeesToPaise = rupeesToPaise;
exports.paiseToRupees = paiseToRupees;
exports.calculateBookingFinancials = calculateBookingFinancials;
exports.calculateRefundFinancials = calculateRefundFinancials;
exports.calculateSettlement = calculateSettlement;
exports.validatePaiseAmount = validatePaiseAmount;
exports.validateBps = validateBps;
exports.verifyLedgerBalance = verifyLedgerBalance;
// ── Constants ─────────────────────────────────────────────────────────────────
const BPS_DIVISOR = 10000;
// ── Helpers ───────────────────────────────────────────────────────────────────
function roundPaise(paise) {
    return Math.round(paise);
}
function bpsToPaise(amountPaise, bps) {
    return roundPaise((amountPaise * bps) / BPS_DIVISOR);
}
function flatPaise(valuePaise) {
    return valuePaise ?? 0;
}
function rupeesToPaise(rupees) {
    return Math.round(rupees * 100);
}
function paiseToRupees(paise) {
    const sign = paise < 0 ? '-' : '';
    const abs = Math.abs(paise);
    const rupees = Math.floor(abs / 100);
    const remainder = abs % 100;
    return `${sign}${rupees}.${remainder.toString().padStart(2, '0')}`;
}
// ── Core Calculations ─────────────────────────────────────────────────────────
function bpsValue(snapshot, key, fallback) {
    const v = snapshot[key];
    return typeof v === 'number' ? v : fallback;
}
function calculateBookingFinancials(input) {
    const { gross_amount_paise, coupon_discount_paise = 0, cancellation_fee_paise = 0, config, } = input;
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
function calculateRefundFinancials(input) {
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
function calculateSettlement(input) {
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
function validatePaiseAmount(paise, fieldName = 'amount') {
    if (!Number.isInteger(paise))
        throw new Error(`${fieldName} must be integer paise, got ${paise}`);
    if (paise < 0)
        throw new Error(`${fieldName} must be non-negative, got ${paise}`);
    if (paise > 1000000000000)
        throw new Error(`${fieldName} exceeds INR 1 crore: ${paise} paise`);
}
function validateBps(bps, fieldName = 'rate') {
    if (bps === undefined)
        throw new Error(`${fieldName} exceeds 100%`);
    if (!Number.isInteger(bps))
        throw new Error(`${fieldName} must be integer bps, got ${bps}`);
    if (bps < 0)
        throw new Error(`${fieldName} must be non-negative, got ${bps}`);
    if (bps > 10000)
        throw new Error(`${fieldName} exceeds 100%: ${bps}`);
}
function verifyLedgerBalance(entries) {
    let total = 0;
    for (const entry of entries) {
        total += entry.direction === 'debit' ? entry.amount_paise : -entry.amount_paise;
    }
    return total === 0;
}
