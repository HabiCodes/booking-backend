const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function fakeDbTimestamp(isoString) {
  return new Date(isoString);
}

function fakeTokenTimestamp(isoString) {
  return isoString;
}

function buggyCompare(dbTimestamp, tokenTimestamp) {
  return dbTimestamp <= tokenTimestamp;
}

function fixedCompare(dbTimestamp, tokenTimestamp) {
  const dbStr = dbTimestamp instanceof Date ? dbTimestamp.toISOString() : String(dbTimestamp);
  return dbStr <= tokenTimestamp;
}

describe('Admin JWT - permissions freshness comparison', () => {
  const dbTimestamp = fakeDbTimestamp('2026-08-29T10:30:45.000Z');
  const tokenTimestamp = fakeTokenTimestamp('2026-08-29T10:30:45.000Z');

  describe('BUG: Date <= string comparison', () => {
    it('Date <= ISO string returns FALSE even for identical timestamps', () => {
      const result = buggyCompare(dbTimestamp, tokenTimestamp);
      assert.strictEqual(result, false, 'BUG CONFIRMED: Date <= string is false for identical timestamps');
    });

    it('Date <= string returns FALSE for older DB timestamps', () => {
      const olderDb = fakeDbTimestamp('2026-01-01T00:00:00.000Z');
      const result = buggyCompare(olderDb, tokenTimestamp);
      assert.strictEqual(result, false, 'Even older DB timestamps are rejected');
    });
  });

  describe('FIX: ISO string comparison', () => {
    it('string <= string returns TRUE for identical timestamps', () => {
      const result = fixedCompare(dbTimestamp, tokenTimestamp);
      assert.strictEqual(result, true, 'Identical timestamps should pass freshness check');
    });

    it('string <= string returns TRUE when DB is older (token is fresh)', () => {
      const olderDb = fakeDbTimestamp('2026-01-01T00:00:00.000Z');
      const result = fixedCompare(olderDb, tokenTimestamp);
      assert.strictEqual(result, true, 'Older DB timestamp should pass - token is fresh');
    });

    it('string <= string returns FALSE when DB is newer (permissions changed)', () => {
      const newerDb = fakeDbTimestamp('2026-12-31T23:59:59.999Z');
      const result = fixedCompare(newerDb, tokenTimestamp);
      assert.strictEqual(result, false, 'Newer DB timestamp should fail - permissions changed since login');
    });
  });

  describe('Round-trip: pg driver -> JWT -> middleware', () => {
    it('JWT encode/decode preserves ISO timestamp as string', () => {
      const payload = { permissions_updated_at: fakeDbTimestamp('2026-08-29T10:30:45.000Z') };
      const encoded = JSON.stringify(payload);
      const decoded = JSON.parse(encoded);
      assert.strictEqual(typeof decoded.permissions_updated_at, 'string');
      assert.strictEqual(decoded.permissions_updated_at, '2026-08-29T10:30:45.000Z');
    });
  });

  describe('UTC timezone independence', () => {
    it('ISO strings are lexicographically ordered correctly', () => {
      const cases = [
        { db: '2026-08-29T10:00:00.000Z', token: '2026-08-29T10:30:45.000Z', expected: true },
        { db: '2026-08-29T11:00:00.000Z', token: '2026-08-29T10:30:45.000Z', expected: false },
        { db: '2026-08-29T10:30:45.000Z', token: '2026-08-29T10:30:45.000Z', expected: true },
        { db: '2025-01-01T00:00:00.000Z', token: '2026-08-29T10:30:45.000Z', expected: true },
      ];
      for (const c of cases) {
        const dbStr = fakeDbTimestamp(c.db).toISOString();
        const result = fixedCompare(dbStr, c.token);
        assert.strictEqual(result, c.expected,
          `DB ${c.db} <= token ${c.token} should be ${c.expected}`);
      }
    });
  });
});
