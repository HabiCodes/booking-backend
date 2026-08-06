/**
 * Unit tests for src/utils/safeToken.ts
 *
 * Covers:
 *   - generateSecureToken: uniqueness, length, url-safe alphabet
 *   - hashToken: deterministic, hex output
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateSecureToken, hashToken } from '../../src/utils/safeToken';

describe('safeToken', () => {
  describe('generateSecureToken', () => {
    it('returns a string of the requested byte-length (in base64url)', () => {
      const t = generateSecureToken(32);
      assert.strictEqual(typeof t, 'string');
      // base64url of 32 bytes ≈ 43 chars
      assert.ok(t.length >= 42);
    });

    it('produces unique tokens on repeated calls', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 200; i++) {
        tokens.add(generateSecureToken());
      }
      assert.strictEqual(tokens.size, 200);
    });

    it('only uses url-safe base64 characters (no +, /, =)', () => {
      const t = generateSecureToken(64);
      assert.ok(/^[A-Za-z0-9_-]+$/.test(t));
    });

    it('default length is at least 32 bytes', () => {
      const t = generateSecureToken();
      assert.ok(t.length >= 40);
    });
  });

  describe('hashToken', () => {
    it('returns a 64-char hex string (SHA-256)', () => {
      const h = hashToken('hello');
      assert.ok(/^[a-f0-9]{64}$/.test(h));
    });

    it('is deterministic for the same input', () => {
      assert.strictEqual(hashToken('abc'), hashToken('abc'));
    });

    it('differs for different inputs', () => {
      assert.notStrictEqual(hashToken('abc'), hashToken('abd'));
    });
  });
});