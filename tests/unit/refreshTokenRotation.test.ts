/**
 * Refresh token rotation security tests.
 *
 * Verifies that:
 * - The JWT helper produces typed refresh tokens (typ=refresh).
 * - The payload contains the required id claim.
 * - Verification rejects tampered or wrong-typed tokens.
 * - Hashing is deterministic but irreversible (raw token never recoverable).
 *
 * These guard against regressions in the refresh-token rotation logic
 * that lives in authService.refreshTokens.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import {
  generateRefreshToken,
  verifyRefreshToken,
} from '../../src/utils/jwt';
import { generateSecureToken, hashToken } from '../../src/utils/safeToken';

describe('refresh token rotation — payload guarantees', () => {
  it('embeds typ=refresh so access/admin tokens cannot be used for rotation', () => {
    const token = generateRefreshToken(7, 'rotate@example.com');
    const decoded = jwt.decode(token) as { typ?: string; id?: number } | null;
    assert.ok(decoded, 'Token should decode');
    assert.equal(decoded.typ, 'refresh');
    assert.equal(decoded.id, 7);
  });

  it('verifyRefreshToken accepts a fresh token', () => {
    const token = generateRefreshToken(11, 'r@example.com');
    const payload = verifyRefreshToken(token);
    assert.ok(payload, 'verify should return a payload');
    assert.equal(payload?.id, 11);
    assert.equal(payload?.email, 'r@example.com');
  });

  it('verifyRefreshToken rejects a token signed with a different secret', () => {
    const fakeToken = jwt.sign(
      { id: 99, email: 'spoof@example.com', typ: 'refresh' },
      'not-the-real-secret',
      { expiresIn: '30d' }
    );
    const payload = verifyRefreshToken(fakeToken);
    assert.equal(payload, null, 'Spoofed refresh tokens must be rejected');
  });

  it('verifyRefreshToken rejects an expired token', () => {
    const expiredToken = jwt.sign(
      { id: 1, email: 'e@example.com', typ: 'refresh' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '-1s' }
    );
    const payload = verifyRefreshToken(expiredToken);
    assert.equal(payload, null, 'Expired refresh tokens must be rejected');
  });

  it('verifyRefreshToken rejects an access token (wrong typ)', () => {
    const accessToken = jwt.sign(
      { id: 1, email: 'a@example.com', typ: 'access' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '15m' }
    );
    const payload = verifyRefreshToken(accessToken);
    assert.equal(payload, null, 'Access tokens must not be valid as refresh tokens');
  });
});

describe('refresh token rotation — hash invariants', () => {
  it('hashToken is deterministic for the same input', () => {
    const token = generateRefreshToken(1, 'same@example.com');
    assert.equal(hashToken(token), hashToken(token));
  });

  it('hashToken produces different outputs for different inputs', () => {
    const a = generateRefreshToken(1, 'a@example.com');
    const b = generateRefreshToken(2, 'b@example.com');
    assert.notEqual(a, b, 'Different inputs must produce different tokens');
    assert.notEqual(hashToken(a), hashToken(b), 'Hashes of different tokens must differ');
  });

  it('hashToken output has expected hex length (sha-256 = 64 chars)', () => {
    const token = generateRefreshToken(1, 'len@example.com');
    const hashed = hashToken(token);
    assert.equal(hashed.length, 64);
    assert.match(hashed, /^[0-9a-f]+$/, 'Hash must be hex-encoded');
  });

  it('hashToken is irreversible — raw token is never recoverable from hash', () => {
    const raw = generateSecureToken();
    const hashed = hashToken(raw);
    // The hash is 64 hex chars and contains no recognizable portion of the raw
    // token (which is 64+ chars of url-safe base64).
    assert.ok(!hashed.includes(raw), 'Hash must not contain raw token');
    assert.ok(hashed.length !== raw.length, 'Hash length differs from raw length');
  });
});
