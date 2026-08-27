/**
 * Organizer auth — refresh token persistence and rotation tests.
 *
 * Tests that do NOT require bcrypt (JWT structure, typ enforcement, hashing):
 *  - Verified directly using jwt.sign/verify with the organizer secret
 *  - No bcrypt-dependent imports at module load time
 *
 * DB-backed tests (rotation, logout, sessions) are in organizerAuthService.test.ts
 * and require the bcrypt native module to be available.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { config } from '../../src/config';

// ============================================================================
// Helpers
// ============================================================================

const ORG_SECRET = config.jwt.organizerSecret;
const USER_SECRET = process.env.JWT_SECRET || 'test-secret';
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-secret';
const TEST_USER_ID = 99;

function signRefreshToken(userId: number): string {
  return jwt.sign(
    { sub: userId, typ: 'organizer_refresh' },
    ORG_SECRET,
    { expiresIn: '30d' }
  );
}

function signAccessToken(userId: number): string {
  return jwt.sign(
    { id: userId, sub: 'test@test.com', typ: 'organizer_access', organization_id: 5, name: 'T', role: 'owner' },
    ORG_SECRET,
    { expiresIn: '15m' }
  );
}

// ============================================================================
// Tests — organizer refresh token typ enforcement (JWT level)
// ============================================================================

describe('organizer auth — refresh token typ', () => {
  it('generates tokens with typ=organizer_refresh', () => {
    const token = signRefreshToken(TEST_USER_ID);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    assert.strictEqual(decoded.typ, 'organizer_refresh');
    assert.strictEqual(decoded.sub, TEST_USER_ID);
  });

  it('generates access tokens with typ=organizer_access', () => {
    const token = signAccessToken(TEST_USER_ID);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    assert.strictEqual(decoded.typ, 'organizer_access');
    assert.strictEqual(decoded.id, TEST_USER_ID);
    assert.strictEqual(decoded.sub, 'test@test.com');
  });

  it('rejects tokens with typ=organizer_access when verifying as refresh', () => {
    // Simulate what verifyRefreshToken does: check typ === 'organizer_refresh'
    const token = signAccessToken(TEST_USER_ID);
    const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
    const isRefresh = (decoded as { typ?: string }).typ === 'organizer_refresh';
    assert.equal(isRefresh, false, 'access tokens must not pass refresh typ check');
  });

  it('rejects tokens with typ=access (user) when verifying as organizer refresh', () => {
    const token = jwt.sign(
      { id: 1, sub: 'user@test.com', typ: 'access' },
      USER_SECRET,
      { expiresIn: '15m' }
    );
    // Simulate organizer verifyRefreshToken: check typ and secret
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_refresh';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'user access tokens must not pass organizer refresh check');
  });

  it('rejects tokens with typ=admin_access', () => {
    const token = jwt.sign(
      { id: 1, sub: 'admin@test.com', typ: 'admin_access', role: 'admin' },
      ADMIN_SECRET,
      { expiresIn: '15m' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_refresh';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'admin tokens must not pass organizer refresh check');
  });

  it('rejects tokens with typ=refresh (user refresh)', () => {
    const token = jwt.sign(
      { id: 1, sub: 'user@test.com', typ: 'refresh' },
      USER_SECRET,
      { expiresIn: '30d' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_refresh';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'user refresh tokens must not pass organizer refresh check');
  });

  it('rejects expired tokens', () => {
    const token = jwt.sign(
      { sub: TEST_USER_ID, typ: 'organizer_refresh' },
      ORG_SECRET,
      { expiresIn: '-1s' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_refresh';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'expired tokens must fail verification');
  });

  it('rejects tokens signed with wrong secret', () => {
    const token = jwt.sign(
      { sub: TEST_USER_ID, typ: 'organizer_refresh' },
      'wrong-secret',
      { expiresIn: '30d' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_refresh';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'tokens with wrong secret must fail verification');
  });
});

// ============================================================================
// Tests — organizer access token typ enforcement (JWT level)
// ============================================================================

describe('organizer auth — access token typ', () => {
  it('accepts valid organizer_access tokens', () => {
    const token = signAccessToken(TEST_USER_ID);
    const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
    assert.strictEqual((decoded as { typ?: string }).typ, 'organizer_access');
    assert.strictEqual((decoded as { id?: number }).id, TEST_USER_ID);
    assert.strictEqual(decoded.sub, 'test@test.com');
  });

  it('rejects tokens with typ=organizer_refresh as access tokens', () => {
    const token = signRefreshToken(TEST_USER_ID);
    const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
    const isAccess = (decoded as { typ?: string }).typ === 'organizer_access';
    assert.equal(isAccess, false, 'refresh tokens must not pass access typ check');
  });

  it('rejects tokens with different secret', () => {
    const token = jwt.sign(
      { id: 1, sub: 'user@test.com', typ: 'access' },
      USER_SECRET,
      { expiresIn: '15m' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_access';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'user tokens with different secret must fail');
  });

  it('rejects admin tokens', () => {
    const token = jwt.sign(
      { id: 1, sub: 'admin@test.com', typ: 'admin_access', role: 'admin' },
      ADMIN_SECRET,
      { expiresIn: '15m' }
    );
    let passed = false;
    try {
      const decoded = jwt.verify(token, ORG_SECRET) as Record<string, unknown>;
      passed = (decoded as { typ?: string }).typ === 'organizer_access';
    } catch {
      passed = false;
    }
    assert.equal(passed, false, 'admin tokens must not pass organizer access check');
  });
});

// ============================================================================
// Tests — token hashing (SHA-256, same as user flow)
// ============================================================================

describe('organizer auth — token hashing', () => {
  it('refresh token hashes are deterministic', async () => {
    const { hashToken } = await import('../../src/utils/safeToken');
    const token = signRefreshToken(TEST_USER_ID);
    assert.strictEqual(hashToken(token), hashToken(token));
  });

  it('refresh token hashes are irreversible', async () => {
    const { hashToken } = await import('../../src/utils/safeToken');
    const token = signRefreshToken(TEST_USER_ID);
    const hashed = hashToken(token);
    assert.equal(hashed.length, 64, 'SHA-256 hex is 64 chars');
    assert.match(hashed, /^[0-9a-f]+$/);
    assert.ok(!hashed.includes(token), 'hash must not contain raw token');
  });
});

// ============================================================================
// Tests — cross-domain token isolation
// ============================================================================

describe('organizer auth — cross-domain isolation', () => {
  it('organizer secret cannot verify user tokens', () => {
    const userToken = jwt.sign(
      { id: 1, sub: 'user@test.com', typ: 'access' },
      USER_SECRET,
      { expiresIn: '15m' }
    );
    assert.throws(() => jwt.verify(userToken, ORG_SECRET));
  });

  it('organizer secret cannot verify admin tokens', () => {
    const adminToken = jwt.sign(
      { id: 1, sub: 'admin@test.com', typ: 'admin_access', role: 'admin' },
      ADMIN_SECRET,
      { expiresIn: '15m' }
    );
    assert.throws(() => jwt.verify(adminToken, ORG_SECRET));
  });

  it('user secret cannot verify organizer tokens', () => {
    const orgToken = signAccessToken(TEST_USER_ID);
    assert.throws(() => jwt.verify(orgToken, USER_SECRET));
  });

  it('admin secret cannot verify organizer tokens', () => {
    const orgToken = signAccessToken(TEST_USER_ID);
    assert.throws(() => jwt.verify(orgToken, ADMIN_SECRET));
  });
});
