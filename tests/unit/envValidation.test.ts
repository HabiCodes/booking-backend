/**
 * Unit tests for src/utils/envValidation.ts
 *
 * Covers:
 *   - Required-secret validation in production
 *   - Length validation (>=16 chars)
 *   - Placeholder detection
 *   - CORS_ORIGIN=* rejection in production
 *   - DATABASE_URL/DB_HOST requirement
 *   - Development-mode tolerance (warnings, not errors)
 *   - Top-level API shape (errors / warnings arrays)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { validateEnv } from '../../src/utils/envValidation';

// Snapshot env so we can restore after the full suite.
const SAVED = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
  ORGANIZER_JWT_SECRET: process.env.ORGANIZER_JWT_SECRET,
  QR_SIGNING_SECRET: process.env.QR_SIGNING_SECRET,
  CORS_ORIGIN: process.env.CORS_ORIGIN,
  DATABASE_URL: process.env.DATABASE_URL,
  DB_HOST: process.env.DB_HOST,
};

after(() => {
  process.env.NODE_ENV = SAVED.NODE_ENV;
  process.env.JWT_SECRET = SAVED.JWT_SECRET;
  process.env.ADMIN_JWT_SECRET = SAVED.ADMIN_JWT_SECRET;
  process.env.ORGANIZER_JWT_SECRET = SAVED.ORGANIZER_JWT_SECRET;
  process.env.QR_SIGNING_SECRET = SAVED.QR_SIGNING_SECRET;
  process.env.CORS_ORIGIN = SAVED.CORS_ORIGIN;
  process.env.DATABASE_URL = SAVED.DATABASE_URL;
  process.env.DB_HOST = SAVED.DB_HOST;
});

/**
 * Reset the entire env to a known-good production configuration.
 * Each test calls this first, then makes one specific mutation.
 */
function primeProdEnv() {
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'a-real-secret-of-sufficient-length-now32';
  process.env.ADMIN_JWT_SECRET = 'another-real-secret-12345-that-is-now-32';
  process.env.ORGANIZER_JWT_SECRET = 'organizer-real-secret-1234567890';
  process.env.QR_SIGNING_SECRET = 'qr-real-secret-6789012345-and-more';
  process.env.CORS_ORIGIN = 'https://app.example.com';
  process.env.DATABASE_URL = 'postgresql://localhost/db';
  delete process.env.DB_HOST;
}

// ── Production mode ───────────────────────────────────────────────────────────

describe('envValidation > production mode', () => {
  it('returns valid for a fully-configured production env', () => {
    primeProdEnv();
    const result = validateEnv();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('flags missing JWT_SECRET', () => {
    primeProdEnv();
    process.env.JWT_SECRET = '';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('JWT_SECRET')));
  });

  it('flags missing ADMIN_JWT_SECRET', () => {
    primeProdEnv();
    process.env.ADMIN_JWT_SECRET = '';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('ADMIN_JWT_SECRET')));
  });

  it('flags missing ORGANIZER_JWT_SECRET', () => {
    primeProdEnv();
    process.env.ORGANIZER_JWT_SECRET = '';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('ORGANIZER_JWT_SECRET')));
  });

  it('flags missing QR_SIGNING_SECRET', () => {
    primeProdEnv();
    process.env.QR_SIGNING_SECRET = '';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('QR_SIGNING_SECRET')));
  });

  it('flags JWT_SECRET shorter than 32 chars', () => {
    primeProdEnv();
    process.env.JWT_SECRET = 'short';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('JWT_SECRET') && String(e).includes('32')));
  });

  it('flags placeholder JWT_SECRET in production', () => {
    primeProdEnv();
    process.env.JWT_SECRET = 'change-me-user-secret-1234567890';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('placeholder')));
  });

  it('flags CORS_ORIGIN=* in production', () => {
    primeProdEnv();
    process.env.CORS_ORIGIN = '*';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('CORS_ORIGIN')));
  });

  it('flags missing database when neither DATABASE_URL nor DB_HOST is set', () => {
    primeProdEnv();
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => String(e).includes('Database')));
  });

  it('accepts DB_HOST when DATABASE_URL is absent', () => {
    primeProdEnv();
    delete process.env.DATABASE_URL;
    process.env.DB_HOST = 'localhost';
    const result = validateEnv();
    assert.strictEqual(result.valid, true);
  });

  it('accepts DATABASE_URL when DB_HOST is absent', () => {
    primeProdEnv();
    delete process.env.DB_HOST;
    const result = validateEnv();
    assert.strictEqual(result.valid, true);
  });

  it('reports all errors at once (not just the first)', () => {
    primeProdEnv();
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.QR_SIGNING_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    process.env.CORS_ORIGIN = '*';
    const result = validateEnv();
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length >= 4);
  });
});

// ── Development mode ──────────────────────────────────────────────────────────

describe('envValidation > development mode', () => {
  it('does not flag missing secrets in dev', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_JWT_SECRET;
    delete process.env.QR_SIGNING_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.DB_HOST;
    const result = validateEnv();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  // Note: placeholder detection runs inside the rules loop, and
  // DEVELOPMENT_REQUIRED is intentionally empty (dev tolerates all values).
  // The placeholder check only fires in production mode.
});

// ── Result shape ──────────────────────────────────────────────────────────────

describe('envValidation > result shape', () => {
  it('always returns { valid, errors, warnings }', () => {
    const result = validateEnv();
    assert.strictEqual(Array.isArray(result.errors), true);
    assert.strictEqual(Array.isArray(result.warnings), true);
    assert.strictEqual(typeof result.valid, 'boolean');
  });
});