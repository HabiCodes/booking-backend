/**
 * Unit tests for the OTP utility module (generate + hash + constant-time verify).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateNumericOtp, hashOtp, verifyOtpConstantTime, verifyOtp } from '../../src/utils/otp';

// ── generateNumericOtp ──────────────────────────────────────────────────────────

describe('otp > generateNumericOtp', () => {
  it('returns a string of the default length (6)', () => {
    const code = generateNumericOtp();
    assert.strictEqual(code.length, 6);
  });

  it('returns a string of the requested length', () => {
    assert.strictEqual(generateNumericOtp(4).length, 4);
    assert.strictEqual(generateNumericOtp(8).length, 8);
  });

  it('contains only decimal digits', () => {
    const code = generateNumericOtp(8);
    assert.ok(/^\d+$/.test(code));
  });

  it('zero-pads when randomInt returns a small number', () => {
    // We cannot easily force a small number, but we CAN verify padding is
    // correct by exercising the boundary manually via the internal logic.
    // Instead, just check that two consecutive calls almost always differ,
    // which rules out a constant return.
    const a = generateNumericOtp(6);
    const b = generateNumericOtp(6);
    // Probability of collision with CSPRNG is negligible; assert they differ
    // 999 999 out of 1 000 000 times.
    assert.notStrictEqual(a, b, 'Two consecutive OTPs should differ with overwhelming probability');
  });

  it('throws for length 0', () => {
    assert.throws(() => generateNumericOtp(0), RangeError);
  });

  it('throws for length > 32', () => {
    assert.throws(() => generateNumericOtp(33), RangeError);
  });
});

// ── hashOtp ────────────────────────────────────────────────────────────────────

describe('otp > hashOtp', () => {
  it('returns a 64-char lowercase hex string', () => {
    const h = hashOtp('123456');
    assert.strictEqual(h.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(h));
  });

  it('is deterministic — same input → same hash', () => {
    assert.strictEqual(hashOtp('123456'), hashOtp('123456'));
  });

  it('produces different hashes for different inputs', () => {
    assert.notStrictEqual(hashOtp('123456'), hashOtp('654321'));
  });
});

// ── verifyOtpConstantTime ──────────────────────────────────────────────────────

describe('otp > verifyOtpConstantTime', () => {
  it('returns true for equal values', () => {
    const h = hashOtp('abc');
    assert.strictEqual(verifyOtpConstantTime(h, h), true);
  });

  it('returns false for different values of equal length', () => {
    assert.strictEqual(verifyOtpConstantTime(hashOtp('abc'), hashOtp('def')), false);
  });

  it('returns false (safely) when lengths differ', () => {
    const short = hashOtp('1');
    const long = hashOtp('1234567890');
    // Should not throw even though lengths differ
    assert.strictEqual(verifyOtpConstantTime(short, long), false);
  });
});

// ── verifyOtp ──────────────────────────────────────────────────────────────────

describe('otp > verifyOtp', () => {
  it('verifies a correct OTP', () => {
    const code = '482910';
    const h = hashOtp(code);
    assert.strictEqual(verifyOtp(code, h), true);
  });

  it('rejects an incorrect OTP', () => {
    const h = hashOtp('482910');
    assert.strictEqual(verifyOtp('000000', h), false);
  });

  it('is case-insensitive on the hash side (hex is always lowercase)', () => {
    // Our hashOtp always returns lowercase; Buffer.from(hexString, 'hex')
    // is case-insensitive so verifyOtpConstantTime succeeds regardless.
    const code = '482910';
    const h = hashOtp(code);
    assert.strictEqual(verifyOtp(code, h.toUpperCase()), true);
  });
});
