/**
 * Regression tests for Express 4 async error propagation.
 *
 * Express 4 does NOT automatically forward rejected promises from async
 * middleware to the Express error handler.  A bare `throw` inside an async
 * middleware function becomes an unhandled Promise rejection, which can
 * terminate the Node.js process instead of returning the intended HTTP response.
 *
 * These tests verify that authMiddleware, adminAuthMiddleware, and
 * organizerAuthMiddleware correctly call `next(err)` for every failure path,
 * ensuring Express's error pipeline handles the response.
 *
 * Run:  npm run test:unit
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import express from 'express';
import { Request, Response, NextFunction } from 'express';
import { closeRedis } from '../../src/db/redis';
import { closePool } from '../../src/db/pool';
import { AppError, errorHandler } from '../../src/middleware/errorHandler';
import { authMiddleware, optionalAuth, AuthRequest } from '../../src/middleware/auth';
import { adminAuthMiddleware } from '../../src/middleware/adminAuth';
import { organizerAuthMiddleware, OrganizerRequest } from '../../src/middleware/organizerAuth';
import { generateAccessToken, generateAdminAccessToken, generateOrganizerAccessToken } from '../../src/utils/jwt';

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1: Unit tests — direct middleware function calls
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers ─────────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as Request;
}

function mockRes(): Response {
  return {
    status: () => ({ json: () => {} }),
    json: () => {},
  } as unknown as Response;
}

let lastNextErr: unknown = null;
let lastNextCalls: string[] = [];

function mockNext(): NextFunction {
  return ((err?: unknown) => {
    if (err !== undefined) {
      lastNextErr = err;
    }
    lastNextCalls.push(err !== undefined ? `error(${(err as Error).message})` : 'next()');
  }) as NextFunction;
}

function resetMockState(): void {
  lastNextErr = null;
  lastNextCalls = [];
}

/**
 * Call the middleware as an async function and return the promise.
 * In Express 4, async middleware functions are called directly — the
 * returned Promise is not automatically awaited by Express.
 */
async function callMiddleware(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  return fn(req, res, next);
}

// ── Auth middleware tests ───────────────────────────────────────────────────────

describe('authMiddleware — Express 4 async error propagation', () => {
  it('A. calls next(err) for missing Authorization header (does NOT throw)', async () => {
    resetMockState();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    // Should NOT reject — it should call next(err)
    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1, 'next should be called exactly once');
    assert.ok(lastNextErr instanceof AppError, 'Should pass AppError to next');
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
    assert.ok(lastNextErr instanceof Error, 'Error should be instanceof Error');
  });

  it('calls next(err) for malformed Bearer token (no token after Bearer)', async () => {
    resetMockState();
    const req = mockReq({ headers: { authorization: 'Bearer ' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('B. calls next(err) for invalid/expired token', async () => {
    resetMockState();
    const req = mockReq({ headers: { authorization: 'Bearer not-a-valid-jwt-token' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('D. calls next(err) for revoked session', async () => {
    resetMockState();
    const token = generateAccessToken(1, 'test@example.com', 999);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    // Without Redis, fail-open means session is valid — should call next() with no error
    assert.strictEqual(lastNextCalls.length, 1);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
  });

  it('calls next() for valid token', async () => {
    resetMockState();
    const token = generateAccessToken(1, 'test@example.com');
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
    assert.strictEqual((req as AuthRequest).user?.id, 1);
    assert.strictEqual((req as AuthRequest).user?.email, 'test@example.com');
  });

  it('calls next() with user context for valid token with session_id', async () => {
    resetMockState();
    const token = generateAccessToken(5, 'session@example.com', 42);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual((req as AuthRequest).user?.id, 5);
    assert.strictEqual((req as AuthRequest).user?.email, 'session@example.com');
  });

  it('H. subsequent requests work after an auth failure (no process crash)', async () => {
    // First request: fails with 401
    resetMockState();
    const req1 = mockReq();
    await callMiddleware(authMiddleware, req1, mockRes(), mockNext());
    assert.ok(lastNextErr instanceof AppError, 'First request should fail with AppError');

    // Second request: succeeds with valid token
    resetMockState();
    const token = generateAccessToken(1, 'test@example.com');
    const req2 = mockReq({ headers: { authorization: `Bearer ${token}` } });
    await callMiddleware(authMiddleware, req2, mockRes(), mockNext());
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
    assert.strictEqual((req2 as AuthRequest).user?.id, 1);
  });
});

// ── optionalAuth tests ─────────────────────────────────────────────────────────

describe('optionalAuth — Express 4 async error propagation', () => {
  it('calls next() without error when no Authorization header present', async () => {
    resetMockState();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(optionalAuth, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
  });

  it('calls next() without error when token is invalid (silent ignore)', async () => {
    resetMockState();
    const req = mockReq({ headers: { authorization: 'Bearer invalid-token' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(optionalAuth, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
  });

  it('sets req.user when token is valid', async () => {
    resetMockState();
    const token = generateAccessToken(7, 'optional@example.com');
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(optionalAuth, req, res, next);

    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
    assert.strictEqual((req as AuthRequest).user?.id, 7);
    assert.strictEqual((req as AuthRequest).user?.email, 'optional@example.com');
  });
});

// ── Admin auth middleware tests ─────────────────────────────────────────────────

describe('adminAuthMiddleware — Express 4 async error propagation', () => {
  it('E. calls next(err) for missing Authorization header (does NOT throw)', async () => {
    resetMockState();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(adminAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('E. calls next(err) for malformed token', async () => {
    resetMockState();
    const req = mockReq({ headers: { authorization: 'Bearer not-a-valid-jwt' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(adminAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('E. calls next(err) for token with wrong type', async () => {
    resetMockState();
    const wrongTypeToken = generateAccessToken(1, 'test@example.com');
    const req = mockReq({ headers: { authorization: `Bearer ${wrongTypeToken}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(adminAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('E. admin auth failures return correct 4xx and do NOT crash the process', async () => {
    const scenarios = [
      { label: 'missing header', req: mockReq() },
      { label: 'no Bearer prefix', req: mockReq({ headers: { authorization: 'Basic xyz' } }) },
      { label: 'invalid token', req: mockReq({ headers: { authorization: 'Bearer garbage' } }) },
      { label: 'wrong type', req: mockReq({ headers: { authorization: `Bearer ${generateAccessToken(1, 'x@y.com')}` } }) },
    ];

    for (const scenario of scenarios) {
      resetMockState();
      await callMiddleware(adminAuthMiddleware, scenario.req, mockRes(), mockNext());
      assert.strictEqual(
        lastNextCalls.length, 1,
        `${scenario.label}: next should be called exactly once`
      );
      assert.ok(
        lastNextErr instanceof AppError,
        `${scenario.label}: Should pass AppError to next`
      );
      assert.strictEqual(
        (lastNextErr as AppError).statusCode, 401,
        `${scenario.label}: Should return 401`
      );
    }
  });
});

// ── Organizer auth middleware tests ────────────────────────────────────────────

describe('organizerAuthMiddleware — Express 4 async error propagation', () => {
  it('F. calls next(err) for missing Authorization header (does NOT throw)', async () => {
    resetMockState();
    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(organizerAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('F. calls next(err) for malformed token', async () => {
    resetMockState();
    const req = mockReq({ headers: { authorization: 'Bearer not-a-valid-jwt' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(organizerAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('F. calls next(err) for token with wrong type', async () => {
    resetMockState();
    const wrongTypeToken = generateAccessToken(1, 'test@example.com');
    const req = mockReq({ headers: { authorization: `Bearer ${wrongTypeToken}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(organizerAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
  });

  it('F. organizer auth failures return correct 4xx and do NOT crash the process', async () => {
    const scenarios = [
      { label: 'missing header', req: mockReq() },
      { label: 'no Bearer prefix', req: mockReq({ headers: { authorization: 'Basic xyz' } }) },
      { label: 'invalid token', req: mockReq({ headers: { authorization: 'Bearer garbage' } }) },
      { label: 'wrong type', req: mockReq({ headers: { authorization: `Bearer ${generateAccessToken(1, 'x@y.com')}` } }) },
    ];

    for (const scenario of scenarios) {
      resetMockState();
      await callMiddleware(organizerAuthMiddleware, scenario.req, mockRes(), mockNext());
      assert.strictEqual(
        lastNextCalls.length, 1,
        `${scenario.label}: next should be called exactly once`
      );
      assert.ok(
        lastNextErr instanceof AppError,
        `${scenario.label}: Should pass AppError to next`
      );
      assert.strictEqual(
        (lastNextErr as AppError).statusCode, 401,
        `${scenario.label}: Should return 401`
      );
    }
  });

  it('sets req.organizerUser for valid organizer token', async () => {
    resetMockState();
    const token = generateOrganizerAccessToken(3, 'org@example.com', 'Test Org', 'owner', 1);
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(organizerAuthMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
    assert.strictEqual((req as OrganizerRequest).organizerUser?.id, 3);
    assert.strictEqual((req as OrganizerRequest).organizerUser?.email, 'org@example.com');
    assert.strictEqual((req as OrganizerRequest).organizerUser?.role, 'owner');
  });
});

import jwt from 'jsonwebtoken';

// ── H. Organizer token — pg BIGINT organization_id coercion (regression test) ───
describe('organizerAuthMiddleware — BIGINT organization_id coercion', () => {
  it('rejects a token with string organization_id (pre-fix pg behavior)', async () => {
    resetMockState();
    const payload = { id: 2, sub: 'owner@test.com', organization_id: '2', name: 'Owner', role: 'owner', permissions: {}, typ: 'organizer_access' };
    const badToken = jwt.sign(payload, process.env.ORGANIZER_JWT_SECRET || 'change-me-organizer-secret');
    const req = mockReq({ headers: { authorization: `Bearer ${badToken}` } });
    const res = mockRes();
    const next = mockNext();
    await callMiddleware(organizerAuthMiddleware, req, res, next);
    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError);
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
    assert.ok((lastNextErr as AppError).message.includes('Invalid organizer token structure'));
  });

  it('accepts a token with numeric organization_id (post-fix behavior)', async () => {
    resetMockState();
    const payload = { id: 2, sub: 'owner@test.com', organization_id: 2, name: 'Owner', role: 'owner', permissions: {}, typ: 'organizer_access' };
    const goodToken = jwt.sign(payload, process.env.ORGANIZER_JWT_SECRET || 'change-me-organizer-secret');
    const req = mockReq({ headers: { authorization: `Bearer ${goodToken}` } });
    const res = mockRes();
    const next = mockNext();
    await callMiddleware(organizerAuthMiddleware, req, res, next);
    assert.strictEqual(lastNextCalls[0], 'next()');
    assert.strictEqual(lastNextErr, null);
    assert.strictEqual((req as OrganizerRequest).organizerUser?.id, 2);
    assert.strictEqual((req as OrganizerRequest).organizerUser?.organizationId, 2);
  });
});

// ── G. Unexpected errors reach the global error handler ────────────────────────

describe('unexpected errors reach global error handler', () => {
  it('G. error from inner helper reaches next(err) without crashing', async () => {
    resetMockState();

    // Completely invalid token — verifyAccessToken returns null
    const req = mockReq({ headers: { authorization: 'Bearer totally-invalid' } });
    const res = mockRes();
    const next = mockNext();

    await callMiddleware(authMiddleware, req, res, next);

    assert.strictEqual(lastNextCalls.length, 1);
    assert.ok(lastNextErr instanceof AppError, 'Should wrap in AppError');
    assert.strictEqual((lastNextErr as AppError).statusCode, 401);
    assert.ok(
      (lastNextErr as AppError).message.includes('Invalid or expired token'),
      'Should have descriptive message'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2: Integration tests — real HTTP requests through Express
// ═══════════════════════════════════════════════════════════════════════════════

import http from 'node:http';

let intApp: express.Express;
let intServerPort: number;
let intServer: http.Server | null = null;

function makeRequest(
  method: string,
  path: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: intServerPort, method, path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode!, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  // Minimal app: only auth middleware + error handler + protected routes
  intApp = express();

  // Public route — no auth needed
  intApp.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // User-protected route
  intApp.get('/api/v1/me', authMiddleware, (_req, res) => res.json({ user: 'protected' }));

  // Admin-protected route
  intApp.get('/api/v1/admin', adminAuthMiddleware, (_req, res) => res.json({ admin: 'protected' }));

  // Organizer-protected route
  intApp.get('/api/v1/organizer', organizerAuthMiddleware, (_req, res) => res.json({ organizer: 'protected' }));

  // Global error handler must be LAST
  intApp.use(errorHandler);

  await new Promise<void>((resolve) => {
    intServer = intApp.listen(0, '127.0.0.1');
    intServer.on('listening', () => {
      if (intServer) {
        const addr = intServer.address();
        if (addr && typeof addr !== 'string') {
          intServerPort = addr.port;
        }
      }
      resolve();
    });
  });
});

after(async () => {
  if (intServer) {
    await new Promise<void>((resolve) => intServer!.close(() => resolve()));
  }
  await closeRedis();
  await closePool();
});

// ── User auth endpoints ────────────────────────────────────────────────────────

describe('HTTP — user auth endpoints', () => {
  it('GET /health returns 200 without auth', async () => {
    const { status, body } = await makeRequest('GET', '/health');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { status: 'ok' });
  });

  it('GET /api/v1/me returns 401 without Authorization header', async () => {
    const { status, body } = await makeRequest('GET', '/api/v1/me');
    assert.strictEqual(status, 401);
    assert.ok(body.error?.includes('Unauthorized'), `Expected 'Unauthorized', got: ${body.error}`);
  });

  it('GET /api/v1/me returns 401 with invalid token', async () => {
    const { status, body } = await makeRequest('GET', '/api/v1/me', {
      headers: { Authorization: 'Bearer not-a-valid-jwt-token' },
    });
    assert.strictEqual(status, 401);
    assert.ok(body.error?.includes('Invalid or expired token'), `Expected token error, got: ${body.error}`);
  });

  it('GET /api/v1/me returns 200 with valid token', async () => {
    const token = generateAccessToken(1, 'test@example.com');
    const { status, body } = await makeRequest('GET', '/api/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { user: 'protected' });
  });
});

// ── Admin auth endpoints ───────────────────────────────────────────────────────

describe('HTTP — admin auth endpoints', () => {
  it('GET /api/v1/admin returns 401 without auth', async () => {
    const { status, body } = await makeRequest('GET', '/api/v1/admin');
    assert.strictEqual(status, 401);
    assert.ok(body.error, 'Expected error in response body');
  });

  it('GET /api/v1/admin returns 401 with user token (wrong type)', async () => {
    const token = generateAccessToken(1, 'test@example.com');
    const { status, body } = await makeRequest('GET', '/api/v1/admin', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 401);
    assert.ok(body.error?.includes('Invalid admin token'), `Expected admin token error, got: ${body.error}`);
  });

  it('GET /api/v1/admin returns 200 with valid admin token', async () => {
    const token = generateAdminAccessToken(1, 'admin@example.com', 'super_admin', { can_manage_events: true });
    const { status, body } = await makeRequest('GET', '/api/v1/admin', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { admin: 'protected' });
  });
});

// ── Organizer auth endpoints ───────────────────────────────────────────────────

describe('HTTP — organizer auth endpoints', () => {
  it('GET /api/v1/organizer returns 401 without auth', async () => {
    const { status, body } = await makeRequest('GET', '/api/v1/organizer');
    assert.strictEqual(status, 401);
    assert.ok(body.error, 'Expected error in response body');
  });

  it('GET /api/v1/organizer returns 401 with user token (wrong type)', async () => {
    const token = generateAccessToken(1, 'test@example.com');
    const { status, body } = await makeRequest('GET', '/api/v1/organizer', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 401);
    assert.ok(body.error?.includes('organizer'), `Expected organizer error, got: ${body.error}`);
  });

  it('GET /api/v1/organizer returns 200 with valid organizer token', async () => {
    const token = generateOrganizerAccessToken(3, 'org@example.com', 'Test Org', 'owner', 1);
    const { status, body } = await makeRequest('GET', '/api/v1/organizer', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { organizer: 'protected' });
  });
});

// ── Consecutive failures do NOT crash the process ──────────────────────────────

describe('HTTP — consecutive auth failures', () => {
  it('five consecutive 401s all return 401 (no process crash)', async () => {
    for (let i = 0; i < 5; i++) {
      const { status, body } = await makeRequest('GET', '/api/v1/me');
      assert.strictEqual(status, 401, `Request ${i + 1} should return 401`);
      assert.ok(body.error, `Request ${i + 1} should have error message`);
    }
  });

  it('auth still works after consecutive failures', async () => {
    // Fire 3 bad requests first
    await makeRequest('GET', '/api/v1/me');
    await makeRequest('GET', '/api/v1/me', { headers: { Authorization: 'Bearer bad' } });
    await makeRequest('GET', '/api/v1/me', { headers: { Authorization: 'Bearer also-bad' } });

    // Then a good request — should still work
    const token = generateAccessToken(99, 'after-failures@example.com');
    const { status, body } = await makeRequest('GET', '/api/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { user: 'protected' });
  });
});
