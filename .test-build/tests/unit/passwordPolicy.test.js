"use strict";
/**
 * Unit tests for src/utils/passwordPolicy.ts
 *
 * Covers each rule in the default policy:
 *   - minLength / maxLength
 *   - uppercase / lowercase / number / special-char
 *   - validation aggregates all errors (does not stop at first)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const passwordPolicy_1 = require("../../src/utils/passwordPolicy");
(0, node_test_1.describe)('passwordPolicy', () => {
    (0, node_test_1.it)('accepts a strong password', () => {
        const r = (0, passwordPolicy_1.validatePassword)('StrongP@ssw0rd');
        strict_1.default.strictEqual(r.valid, true);
        strict_1.default.strictEqual(r.errors.length, 0);
    });
    (0, node_test_1.it)('rejects passwords shorter than minLength', () => {
        const r = (0, passwordPolicy_1.validatePassword)('Aa1!aaa'); // 7 chars, < 8
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('at least')));
    });
    (0, node_test_1.it)('rejects passwords longer than maxLength', () => {
        const long = 'A1a!' + 'a'.repeat(130);
        const r = (0, passwordPolicy_1.validatePassword)(long);
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('at most')));
    });
    (0, node_test_1.it)('rejects passwords with no uppercase letter', () => {
        const r = (0, passwordPolicy_1.validatePassword)('weakp@ssw0rd');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('uppercase')));
    });
    (0, node_test_1.it)('rejects passwords with no lowercase letter', () => {
        const r = (0, passwordPolicy_1.validatePassword)('WEAKP@SSW0RD');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('lowercase')));
    });
    (0, node_test_1.it)('rejects passwords with no digit', () => {
        const r = (0, passwordPolicy_1.validatePassword)('WeakP@ssword');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('number')));
    });
    (0, node_test_1.it)('rejects passwords with no special character', () => {
        const r = (0, passwordPolicy_1.validatePassword)('WeakPassw0rd');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.some((e) => String(e).includes('special character')));
    });
    (0, node_test_1.it)('aggregates all errors at once', () => {
        const r = (0, passwordPolicy_1.validatePassword)('abc');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.length >= 3);
    });
    (0, node_test_1.it)('handles empty password safely', () => {
        const r = (0, passwordPolicy_1.validatePassword)('');
        strict_1.default.strictEqual(r.valid, false);
        strict_1.default.ok(r.errors.length > 0);
    });
    (0, node_test_1.it)('respects a custom lenient policy override', () => {
        const lenient = {
            ...passwordPolicy_1.defaultPasswordPolicy,
            minLength: 4,
            requireUppercase: false,
            requireLowercase: false,
            requireNumber: false,
            requireSpecialChar: false,
        };
        const r = (0, passwordPolicy_1.validatePassword)('abcd', lenient);
        strict_1.default.strictEqual(r.valid, true);
    });
});
