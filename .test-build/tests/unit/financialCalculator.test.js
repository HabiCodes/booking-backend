"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = __importDefault(require("node:assert"));
const financialCalculator_1 = require("../../src/services/financialCalculator");
(0, node_test_1.describe)('FinancialCalculator - rounding', () => {
    (0, node_test_1.it)('roundPaise rounds to nearest integer', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(0), 0);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(100), 100);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(149), 149);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(150), 150);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(999), 999);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(-1049), -1049);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(-1050), -1050);
        node_assert_1.default.strictEqual((0, financialCalculator_1.roundPaise)(-99), -99);
    });
});
(0, node_test_1.describe)('FinancialCalculator - bpsToPaise', () => {
    (0, node_test_1.it)('converts percentages', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.bpsToPaise)(100000, 1800), 18000);
        node_assert_1.default.strictEqual((0, financialCalculator_1.bpsToPaise)(100000, 500), 5000);
        node_assert_1.default.strictEqual((0, financialCalculator_1.bpsToPaise)(33300, 1800), 5994);
        node_assert_1.default.strictEqual((0, financialCalculator_1.bpsToPaise)(100000, 0), 0);
        node_assert_1.default.strictEqual((0, financialCalculator_1.bpsToPaise)(100000, 10000), 100000);
    });
});
(0, node_test_1.describe)('FinancialCalculator - conversion helpers', () => {
    (0, node_test_1.it)('rupeesToPaise', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.rupeesToPaise)(100), 10000);
        node_assert_1.default.strictEqual((0, financialCalculator_1.rupeesToPaise)(0.5), 50);
    });
    (0, node_test_1.it)('paiseToRupees', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.paiseToRupees)(100), '1.00');
        node_assert_1.default.strictEqual((0, financialCalculator_1.paiseToRupees)(50), '0.50');
        node_assert_1.default.strictEqual((0, financialCalculator_1.paiseToRupees)(999), '9.99');
        node_assert_1.default.strictEqual((0, financialCalculator_1.paiseToRupees)(-500), '-5.00');
    });
});
(0, node_test_1.describe)('FinancialCalculator - calculateBookingFinancials', () => {
    const defaultConfig = {
        gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
        cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
    };
    (0, node_test_1.it)('basic booking', () => {
        const result = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, config: defaultConfig });
        node_assert_1.default.strictEqual(result.platform_fee_paise, 5000);
        node_assert_1.default.strictEqual(result.gst_on_platform_fee_paise, 900);
        node_assert_1.default.strictEqual(result.commission_paise, 10000);
        node_assert_1.default.strictEqual(result.tds_paise, 0);
        node_assert_1.default.strictEqual(result.total_customer_charged_paise, 105900);
        node_assert_1.default.strictEqual(result.net_payable_to_business_paise, 90000);
    });
    (0, node_test_1.it)('coupon discount', () => {
        const result = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, coupon_discount_paise: 10000, config: defaultConfig });
        node_assert_1.default.strictEqual(result.coupon_discount_paise, 10000);
        node_assert_1.default.strictEqual(result.total_customer_charged_paise, 95900);
        node_assert_1.default.strictEqual(result.net_payable_to_business_paise, 80000);
    });
    (0, node_test_1.it)('cancellation fee', () => {
        const result = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, cancellation_fee_paise: 5000, config: defaultConfig });
        node_assert_1.default.strictEqual(result.cancellation_fee_paise, 5000);
        node_assert_1.default.strictEqual(result.net_payable_to_business_paise, 95000);
    });
    (0, node_test_1.it)('TDS calculation', () => {
        const cfg = { ...defaultConfig, tds_bps: 100 };
        const result = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, config: cfg });
        node_assert_1.default.strictEqual(result.tds_paise, 100);
        node_assert_1.default.strictEqual(result.net_payable_to_business_paise, 89900);
    });
    (0, node_test_1.it)('preserves config snapshot', () => {
        const result = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, config: defaultConfig });
        node_assert_1.default.deepStrictEqual(result.config_snapshot, defaultConfig);
    });
});
(0, node_test_1.describe)('FinancialCalculator - calculateRefundFinancials', () => {
    const defaultConfig = {
        gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
        cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
    };
    const originalBreakdown = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, config: defaultConfig });
    (0, node_test_1.it)('100% refund', () => {
        const result = (0, financialCalculator_1.calculateRefundFinancials)({ originalBreakdown, refund_percentage: 100 });
        node_assert_1.default.strictEqual(result.refund_amount_paise, 105900);
        node_assert_1.default.strictEqual(result.platform_fee_refund_paise, 5000);
        node_assert_1.default.strictEqual(result.gst_refund_paise, 900);
        node_assert_1.default.strictEqual(result.commission_reversal_paise, 10000);
        node_assert_1.default.strictEqual(result.business_debit_paise, 90000);
    });
    (0, node_test_1.it)('50% refund', () => {
        const result = (0, financialCalculator_1.calculateRefundFinancials)({ originalBreakdown, refund_percentage: 50 });
        node_assert_1.default.strictEqual(result.refund_amount_paise, 52950);
        node_assert_1.default.strictEqual(result.platform_fee_refund_paise, 2500);
        node_assert_1.default.strictEqual(result.gst_refund_paise, 450);
        node_assert_1.default.strictEqual(result.commission_reversal_paise, 5000);
        node_assert_1.default.strictEqual(result.business_debit_paise, 45000);
    });
    (0, node_test_1.it)('full refund returns total customer charged', () => {
        const result = (0, financialCalculator_1.calculateRefundFinancials)({ originalBreakdown, refund_percentage: 100 });
        node_assert_1.default.strictEqual(result.refund_amount_paise, originalBreakdown.total_customer_charged_paise);
    });
    (0, node_test_1.it)('refund with coupon preserves benefit', () => {
        const withCoupon = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, coupon_discount_paise: 10000, config: defaultConfig });
        const refund = (0, financialCalculator_1.calculateRefundFinancials)({ originalBreakdown: withCoupon, refund_percentage: 100 });
        node_assert_1.default.strictEqual(refund.refund_amount_paise, withCoupon.total_customer_charged_paise);
    });
});
(0, node_test_1.describe)('FinancialCalculator - calculateSettlement', () => {
    const defaultConfig = {
        gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
        cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
    };
    (0, node_test_1.it)('settlement from breakdown', () => {
        const breakdown = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, cancellation_fee_paise: 5000, config: defaultConfig });
        const result = (0, financialCalculator_1.calculateSettlement)({ booking_id: 1, breakdown });
        node_assert_1.default.strictEqual(result.booking_id, 1);
        node_assert_1.default.strictEqual(result.gross_amount_paise, 100000);
        node_assert_1.default.strictEqual(result.net_settlement_paise, 95000);
        node_assert_1.default.strictEqual(result.final_payout_paise, 95000);
    });
    (0, node_test_1.it)('with adjustment', () => {
        const breakdown = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 100000, config: defaultConfig });
        const result = (0, financialCalculator_1.calculateSettlement)({ booking_id: 1, breakdown, adjustment_paise: -5000 });
        node_assert_1.default.strictEqual(result.final_payout_paise, 85000);
    });
});
(0, node_test_1.describe)('FinancialCalculator - validation', () => {
    (0, node_test_1.it)('validatePaiseAmount accepts valid', () => {
        node_assert_1.default.doesNotThrow(() => (0, financialCalculator_1.validatePaiseAmount)(0));
        node_assert_1.default.doesNotThrow(() => (0, financialCalculator_1.validatePaiseAmount)(500));
    });
    (0, node_test_1.it)('validatePaiseAmount rejects floats', () => {
        node_assert_1.default.throws(() => (0, financialCalculator_1.validatePaiseAmount)(100.5), /integer paise/);
    });
    (0, node_test_1.it)('validatePaiseAmount rejects negative', () => {
        node_assert_1.default.throws(() => (0, financialCalculator_1.validatePaiseAmount)(-1), /non-negative/);
    });
    (0, node_test_1.it)('validatePaiseAmount rejects > 1 crore', () => {
        node_assert_1.default.throws(() => (0, financialCalculator_1.validatePaiseAmount)(1000000000001), /exceeds INR 1 crore/);
    });
    (0, node_test_1.it)('validateBps accepts valid', () => {
        node_assert_1.default.doesNotThrow(() => (0, financialCalculator_1.validateBps)(0));
        node_assert_1.default.doesNotThrow(() => (0, financialCalculator_1.validateBps)(500));
    });
    (0, node_test_1.it)('validateBps rejects floats', () => {
        node_assert_1.default.throws(() => (0, financialCalculator_1.validateBps)(18.5), /integer bps/);
    });
    (0, node_test_1.it)('validateBps rejects > 100%', () => {
        node_assert_1.default.throws(() => (0, financialCalculator_1.validateBps)(), /exceeds 100%/);
    });
});
(0, node_test_1.describe)('FinancialCalculator - verifyLedgerBalance', () => {
    (0, node_test_1.it)('balanced entries', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.verifyLedgerBalance)([{ amount_paise: 1000, direction: 'debit' }, { amount_paise: 1000, direction: 'credit' }]), true);
    });
    (0, node_test_1.it)('unbalanced entries', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.verifyLedgerBalance)([{ amount_paise: 1000, direction: 'debit' }, { amount_paise: 500, direction: 'credit' }]), false);
    });
    (0, node_test_1.it)('multiple entries', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.verifyLedgerBalance)([{ amount_paise: 100, direction: 'debit' }, { amount_paise: 30, direction: 'debit' }, { amount_paise: 130, direction: 'credit' }]), true);
    });
    (0, node_test_1.it)('empty entries', () => {
        node_assert_1.default.strictEqual((0, financialCalculator_1.verifyLedgerBalance)([]), true);
    });
});
(0, node_test_1.describe)('FinancialCalculator - money conservation', () => {
    const defaultConfig = {
        gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
        cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
    };
    (0, node_test_1.it)('full refund returns total customer charged', () => {
        for (const grossPaise of [100000, 500000, 1000000, 9999999]) {
            const breakdown = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: grossPaise, config: defaultConfig });
            const refund = (0, financialCalculator_1.calculateRefundFinancials)({ originalBreakdown: breakdown, refund_percentage: 100 });
            node_assert_1.default.strictEqual(refund.refund_amount_paise, breakdown.total_customer_charged_paise);
        }
    });
    (0, node_test_1.it)('no float precision errors', () => {
        let cumulative = 0n;
        for (let i = 0; i < 10000; i++)
            cumulative += 12345n;
        node_assert_1.default.strictEqual(cumulative, 123450000n);
    });
});
(0, node_test_1.describe)('FinancialCalculator - rounding consistency', () => {
    (0, node_test_1.it)('same inputs always same outputs', () => {
        const config = {
            gst_bps: 1850, platform_fee_bps: 375, commission_bps: 1200, tds_bps: 50,
            cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
        };
        const results = [];
        for (let i = 0; i < 100; i++) {
            const r = (0, financialCalculator_1.calculateBookingFinancials)({ gross_amount_paise: 77777, config });
            results.push(r.total_customer_charged_paise);
        }
        node_assert_1.default.strictEqual(new Set(results).size, 1);
    });
});
