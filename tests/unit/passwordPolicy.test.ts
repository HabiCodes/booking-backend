/**
 * Unit tests for src/utils/passwordPolicy.ts
 *
 * Covers each rule in the default policy:
 *   - minLength / maxLength
 *   - uppercase / lowercase / number / special-char
 *   - validation aggregates all errors (does not stop at first)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePassword, defaultPasswordPolicy } from '../../src/utils/passwordPolicy';

describe('passwordPolicy', () => {
  it('accepts a strong password', () => {
    const r = validatePassword('StrongP@ssw0rd');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.errors.length, 0);
  });

  it('rejects passwords shorter than minLength', () => {
    const r = validatePassword('Aa1!aaa'); // 7 chars, < 8
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('at least')));
  });

  it('rejects passwords longer than maxLength', () => {
    const long = 'A1a!' + 'a'.repeat(130);
    const r = validatePassword(long);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('at most')));
  });

  it('rejects passwords with no uppercase letter', () => {
    const r = validatePassword('weakp@ssw0rd');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('uppercase')));
  });

  it('rejects passwords with no lowercase letter', () => {
    const r = validatePassword('WEAKP@SSW0RD');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('lowercase')));
  });

  it('rejects passwords with no digit', () => {
    const r = validatePassword('WeakP@ssword');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('number')));
  });

  it('rejects passwords with no special character', () => {
    const r = validatePassword('WeakPassw0rd');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some((e) => String(e).includes('special character')));
  });

  it('aggregates all errors at once', () => {
    const r = validatePassword('abc');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length >= 3);
  });

  it('handles empty password safely', () => {
    const r = validatePassword('');
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.length > 0);
  });

  it('respects a custom lenient policy override', () => {
    const lenient = {
      ...defaultPasswordPolicy,
      minLength: 4,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
      requireSpecialChar: false,
    };
    const r = validatePassword('abcd', lenient);
    assert.strictEqual(r.valid, true);
  });
});