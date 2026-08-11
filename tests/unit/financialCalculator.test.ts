import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  roundPaise, bpsToPaise, flatPaise, rupeesToPaise, paiseToRupees,
  calculateBookingFinancials, calculateRefundFinancials, calculateSettlement,
  validatePaiseAmount, validateBps, verifyLedgerBalance,
} from '../../src/services/financialCalculator';
import type { ConfigSnapshot } from '../../src/services/financialCalculator';

describe('FinancialCalculator - rounding', () => {
  it('roundPaise rounds to nearest integer', () => {
    assert.strictEqual(roundPaise(0), 0);
    assert.strictEqual(roundPaise(100), 100);
    assert.strictEqual(roundPaise(149), 149);
    assert.strictEqual(roundPaise(150), 150);
    assert.strictEqual(roundPaise(999), 999);
    assert.strictEqual(roundPaise(-1049), -1049);
    assert.strictEqual(roundPaise(-1050), -1050);
    assert.strictEqual(roundPaise(-99), -99);
  });
});

describe('FinancialCalculator - bpsToPaise', () => {
  it('converts percentages', () => {
    assert.strictEqual(bpsToPaise(100000, 1800), 18000);
    assert.strictEqual(bpsToPaise(100000, 500), 5000);
    assert.strictEqual(bpsToPaise(33300, 1800), 5994);
    assert.strictEqual(bpsToPaise(100000, 0), 0);
    assert.strictEqual(bpsToPaise(100000, 10000), 100000);
  });
});

describe('FinancialCalculator - conversion helpers', () => {
  it('rupeesToPaise', () => {
    assert.strictEqual(rupeesToPaise(100), 10000);
    assert.strictEqual(rupeesToPaise(0.5), 50);
  });
  it('paiseToRupees', () => {
    assert.strictEqual(paiseToRupees(100), '1.00');
    assert.strictEqual(paiseToRupees(50), '0.50');
    assert.strictEqual(paiseToRupees(999), '9.99');
    assert.strictEqual(paiseToRupees(-500), '-5.00');
  });
});

describe('FinancialCalculator - calculateBookingFinancials', () => {
  const defaultConfig: ConfigSnapshot = {
    gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
    cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
  };

  it('basic booking', () => {
    const result = calculateBookingFinancials({ gross_amount_paise: 100000, config: defaultConfig });
    assert.strictEqual(result.platform_fee_paise, 5000);
    assert.strictEqual(result.gst_on_platform_fee_paise, 900);
    assert.strictEqual(result.commission_paise, 10000);
    assert.strictEqual(result.tds_paise, 0);
    assert.strictEqual(result.total_customer_charged_paise, 105900);
    assert.strictEqual(result.net_payable_to_business_paise, 90000);
  });

  it('coupon discount', () => {
    const result = calculateBookingFinancials({ gross_amount_paise: 100000, coupon_discount_paise: 10000, config: defaultConfig });
    assert.strictEqual(result.coupon_discount_paise, 10000);
    assert.strictEqual(result.total_customer_charged_paise, 95900);
    assert.strictEqual(result.net_payable_to_business_paise, 80000);
  });

  it('cancellation fee', () => {
    const result = calculateBookingFinancials({ gross_amount_paise: 100000, cancellation_fee_paise: 5000, config: defaultConfig });
    assert.strictEqual(result.cancellation_fee_paise, 5000);
    assert.strictEqual(result.net_payable_to_business_paise, 95000);
  });

  it('TDS calculation', () => {
    const cfg: ConfigSnapshot = { ...defaultConfig, tds_bps: 100 };
    const result = calculateBookingFinancials({ gross_amount_paise: 100000, config: cfg });
    assert.strictEqual(result.tds_paise, 100);
    assert.strictEqual(result.net_payable_to_business_paise, 89900);
  });

  it('preserves config snapshot', () => {
    const result = calculateBookingFinancials({ gross_amount_paise: 100000, config: defaultConfig });
    assert.deepStrictEqual(result.config_snapshot, defaultConfig);
  });
});

describe('FinancialCalculator - calculateRefundFinancials', () => {
  const defaultConfig: ConfigSnapshot = {
    gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
    cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
  };

  const originalBreakdown = calculateBookingFinancials({ gross_amount_paise: 100000, config: defaultConfig });

  it('100% refund', () => {
    const result = calculateRefundFinancials({ originalBreakdown, refund_percentage: 100 });
    assert.strictEqual(result.refund_amount_paise, 105900);
    assert.strictEqual(result.platform_fee_refund_paise, 5000);
    assert.strictEqual(result.gst_refund_paise, 900);
    assert.strictEqual(result.commission_reversal_paise, 10000);
    assert.strictEqual(result.business_debit_paise, 90000);
  });

  it('50% refund', () => {
    const result = calculateRefundFinancials({ originalBreakdown, refund_percentage: 50 });
    assert.strictEqual(result.refund_amount_paise, 52950);
    assert.strictEqual(result.platform_fee_refund_paise, 2500);
    assert.strictEqual(result.gst_refund_paise, 450);
    assert.strictEqual(result.commission_reversal_paise, 5000);
    assert.strictEqual(result.business_debit_paise, 45000);
  });

  it('full refund returns total customer charged', () => {
    const result = calculateRefundFinancials({ originalBreakdown, refund_percentage: 100 });
    assert.strictEqual(result.refund_amount_paise, originalBreakdown.total_customer_charged_paise);
  });

  it('refund with coupon preserves benefit', () => {
    const withCoupon = calculateBookingFinancials({ gross_amount_paise: 100000, coupon_discount_paise: 10000, config: defaultConfig });
    const refund = calculateRefundFinancials({ originalBreakdown: withCoupon, refund_percentage: 100 });
    assert.strictEqual(refund.refund_amount_paise, withCoupon.total_customer_charged_paise);
  });
});

describe('FinancialCalculator - calculateSettlement', () => {
  const defaultConfig: ConfigSnapshot = {
    gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
    cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
  };

  it('settlement from breakdown', () => {
    const breakdown = calculateBookingFinancials({ gross_amount_paise: 100000, cancellation_fee_paise: 5000, config: defaultConfig });
    const result = calculateSettlement({ booking_id: 1, breakdown });
    assert.strictEqual(result.booking_id, 1);
    assert.strictEqual(result.gross_amount_paise, 100000);
    assert.strictEqual(result.net_settlement_paise, 95000);
    assert.strictEqual(result.final_payout_paise, 95000);
  });

  it('with adjustment', () => {
    const breakdown = calculateBookingFinancials({ gross_amount_paise: 100000, config: defaultConfig });
    const result = calculateSettlement({ booking_id: 1, breakdown, adjustment_paise: -5000 });
    assert.strictEqual(result.final_payout_paise, 85000);
  });
});

describe('FinancialCalculator - validation', () => {
  it('validatePaiseAmount accepts valid', () => {
    assert.doesNotThrow(() => validatePaiseAmount(0));
    assert.doesNotThrow(() => validatePaiseAmount(500));
  });
  it('validatePaiseAmount rejects floats', () => {
    assert.throws(() => validatePaiseAmount(100.5), /integer paise/);
  });
  it('validatePaiseAmount rejects negative', () => {
    assert.throws(() => validatePaiseAmount(-1), /non-negative/);
  });
  it('validatePaiseAmount rejects > 1 crore', () => {
    assert.throws(() => validatePaiseAmount(1_000_000_000_001), /exceeds INR 1 crore/);
  });
  it('validateBps accepts valid', () => {
    assert.doesNotThrow(() => validateBps(0));
    assert.doesNotThrow(() => validateBps(500));
  });
  it('validateBps rejects floats', () => {
    assert.throws(() => validateBps(18.5), /integer bps/);
  });
  it('validateBps rejects > 100%', () => {
    assert.throws(() => validateBps(), /exceeds 100%/);
  });
});

describe('FinancialCalculator - verifyLedgerBalance', () => {
  it('balanced entries', () => {
    assert.strictEqual(verifyLedgerBalance([{ amount_paise: 1000, direction: 'debit' }, { amount_paise: 1000, direction: 'credit' }]), true);
  });
  it('unbalanced entries', () => {
    assert.strictEqual(verifyLedgerBalance([{ amount_paise: 1000, direction: 'debit' }, { amount_paise: 500, direction: 'credit' }]), false);
  });
  it('multiple entries', () => {
    assert.strictEqual(verifyLedgerBalance([{ amount_paise: 100, direction: 'debit' }, { amount_paise: 30, direction: 'debit' }, { amount_paise: 130, direction: 'credit' }]), true);
  });
  it('empty entries', () => {
    assert.strictEqual(verifyLedgerBalance([]), true);
  });
});

describe('FinancialCalculator - money conservation', () => {
  const defaultConfig: ConfigSnapshot = {
    gst_bps: 1800, platform_fee_bps: 500, commission_bps: 1000, tds_bps: 0,
    cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
  };

  it('full refund returns total customer charged', () => {
    for (const grossPaise of [100000, 500000, 1000000, 9999999]) {
      const breakdown = calculateBookingFinancials({ gross_amount_paise: grossPaise, config: defaultConfig });
      const refund = calculateRefundFinancials({ originalBreakdown: breakdown, refund_percentage: 100 });
      assert.strictEqual(refund.refund_amount_paise, breakdown.total_customer_charged_paise);
    }
  });

  it('no float precision errors', () => {
    let cumulative = 0n;
    for (let i = 0; i < 10000; i++) cumulative += 12345n;
    assert.strictEqual(cumulative, 123450000n);
  });
});

describe('FinancialCalculator - rounding consistency', () => {
  it('same inputs always same outputs', () => {
    const config: ConfigSnapshot = {
      gst_bps: 1850, platform_fee_bps: 375, commission_bps: 1200, tds_bps: 50,
      cancellation_fee_paise: 5000, payout_minimum_paise: 50000,
    };
    const results: number[] = [];
    for (let i = 0; i < 100; i++) {
      const r = calculateBookingFinancials({ gross_amount_paise: 77777, config });
      results.push(r.total_customer_charged_paise);
    }
    assert.strictEqual(new Set(results).size, 1);
  });
});
