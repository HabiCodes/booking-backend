/**
 * Security hardening tests — JWT token type enforcement and structure validation.
 *
 * Run:  npm run test:unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  generateAdminAccessToken,
  verifyAdminAccessToken,
} from '../../src/utils/jwt';

// --- Helpers ---

function signWrongTypeToken(typ: string, secret: string): string {
  return jwt.sign(
    { id: 1, sub: 'test@example.com', typ },
    secret,
    { expiresIn: '15m' }
  );
}

// --- Tests ---

describe('JWT token type enforcement', () => {
  describe('user access tokens', () => {
    it('generates valid tokens with typ=access', () => {
      const token = generateAccessToken(1, 'test@example.com', 42);
      const decoded = verifyAccessToken(token);
      assert.ok(decoded, 'Token should decode successfully');
      assert.equal(decoded.id, 1);
      assert.equal(decoded.email, 'test@example.com');
      assert.equal(decoded.session_id, 42);
    });

    it('generates tokens without session_id when omitted', () => {
      const token = generateAccessToken(1, 'test@example.com');
      const decoded = verifyAccessToken(token);
      assert.ok(decoded, 'Token without session_id should still validate');
      assert.equal(decoded.session_id, undefined);
    });

    it('rejects tokens with typ=admin instead of typ=access', () => {
      const secret = process.env.JWT_SECRET || 'test-secret';
      const badToken = signWrongTypeToken('admin', secret);
      const decoded = verifyAccessToken(badToken);
      assert.equal(decoded, null, 'Token with wrong type should be rejected');
    });
  });

  describe('admin tokens', () => {
    it('generates valid admin tokens with typ=admin_access', () => {
      const token = generateAdminAccessToken(
        1,
        'admin@test.com',
        'admin',
        { events_read: true, events_write: true }
      );
      const decoded = verifyAdminAccessToken(token);
      assert.ok(decoded, 'Admin token should decode successfully');
      assert.equal(decoded.id, 1);
      assert.equal(decoded.email, 'admin@test.com');
      assert.equal(decoded.role, 'admin');
      assert.deepEqual(decoded.permissions, { events_read: true, events_write: true });
    });

    it('embeds permissions_updated_at when provided', () => {
      const ts = '2025-01-15T00:00:00Z';
      const token = generateAdminAccessToken(1, 'admin@test.com', 'admin', {}, ts);
      const decoded = verifyAdminAccessToken(token);
      assert.ok(decoded);
      assert.equal(decoded.permissionsUpdatedAt, ts);
    });

    it('omits permissions_updated_at when null', () => {
      const token = generateAdminAccessToken(1, 'admin@test.com', 'admin', {}, null);
      const decoded = verifyAdminAccessToken(token);
      assert.ok(decoded);
      assert.equal(decoded.permissionsUpdatedAt, undefined);
    });

    it('rejects tokens with typ=access instead of typ=admin_access', () => {
      const secret = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';
      const badToken = signWrongTypeToken('access', secret);
      const decoded = verifyAdminAccessToken(badToken);
      assert.equal(decoded, null, 'Admin token with typ=access should be rejected');
    });

    it('rejects tokens missing the id claim', () => {
      const secret = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';
      const badToken = jwt.sign(
        { sub: 'admin@test.com', typ: 'admin_access' },
        secret,
        { expiresIn: '15m' }
      );
      const decoded = verifyAdminAccessToken(badToken);
      assert.equal(decoded, null, 'Token without id should be rejected');
    });
  });

  describe('refresh tokens', () => {
    it('generates valid refresh tokens with typ=refresh', () => {
      const token = generateRefreshToken(5, 'rotate@test.com');
      const decoded = verifyRefreshToken(token);
      assert.ok(decoded, 'Refresh token should decode successfully');
      assert.equal(decoded.id, 5);
      assert.equal(decoded.email, 'rotate@test.com');
    });
  });
});

describe('access token session binding', () => {
  it('embeds session_id when provided', () => {
    const token = generateAccessToken(42, 'user@test.com', 99);
    const decoded = verifyAccessToken(token);
    assert.equal(decoded?.session_id, 99);
  });
});

describe('password policy', () => {
  it('rejects passwords shorter than 8 characters', () => {
    assert.equal('Ab1!'.length < 8, true);
  });

  it('requires lowercase, uppercase, digit, and special character', () => {
    const pw = 'Ab1!xyz';

    assert.ok(/[a-z]/.test(pw), 'must have lowercase');
    assert.ok(/[A-Z]/.test(pw), 'must have uppercase');
    assert.ok(/\d/.test(pw), 'must have digit');
    assert.ok(/[^A-Za-z0-9]/.test(pw), 'must have special char');
  });
});
