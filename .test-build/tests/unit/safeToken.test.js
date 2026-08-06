"use strict";
/**
 * Unit tests for src/utils/safeToken.ts
 *
 * Covers:
 *   - generateSecureToken: uniqueness, length, url-safe alphabet
 *   - hashToken: deterministic, hex output
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const safeToken_1 = require("../../src/utils/safeToken");
(0, node_test_1.describe)('safeToken', () => {
    (0, node_test_1.describe)('generateSecureToken', () => {
        (0, node_test_1.it)('returns a string of the requested byte-length (in base64url)', () => {
            const t = (0, safeToken_1.generateSecureToken)(32);
            strict_1.default.strictEqual(typeof t, 'string');
            // base64url of 32 bytes ≈ 43 chars
            strict_1.default.ok(t.length >= 42);
        });
        (0, node_test_1.it)('produces unique tokens on repeated calls', () => {
            const tokens = new Set();
            for (let i = 0; i < 200; i++) {
                tokens.add((0, safeToken_1.generateSecureToken)());
            }
            strict_1.default.strictEqual(tokens.size, 200);
        });
        (0, node_test_1.it)('only uses url-safe base64 characters (no +, /, =)', () => {
            const t = (0, safeToken_1.generateSecureToken)(64);
            strict_1.default.ok(/^[A-Za-z0-9_-]+$/.test(t));
        });
        (0, node_test_1.it)('default length is at least 32 bytes', () => {
            const t = (0, safeToken_1.generateSecureToken)();
            strict_1.default.ok(t.length >= 40);
        });
    });
    (0, node_test_1.describe)('hashToken', () => {
        (0, node_test_1.it)('returns a 64-char hex string (SHA-256)', () => {
            const h = (0, safeToken_1.hashToken)('hello');
            strict_1.default.ok(/^[a-f0-9]{64}$/.test(h));
        });
        (0, node_test_1.it)('is deterministic for the same input', () => {
            strict_1.default.strictEqual((0, safeToken_1.hashToken)('abc'), (0, safeToken_1.hashToken)('abc'));
        });
        (0, node_test_1.it)('differs for different inputs', () => {
            strict_1.default.notStrictEqual((0, safeToken_1.hashToken)('abc'), (0, safeToken_1.hashToken)('abd'));
        });
    });
});
