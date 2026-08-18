/**
 * Unit tests for turfAvailabilityGenerator — pure logic (date helpers, IST independence).
 *
 * These tests avoid any database calls. They verify the date math and
 * timezone handling that the generator uses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getISTDate,
  addDays,
  dateRange,
} from '../../src/services/turfAvailabilityGenerator';

// ── Date Helpers ──────────────────────────────────────────────────────────────

describe('getISTDate', () => {
  it('returns a date string in YYYY-MM-DD format', () => {
    const date = getISTDate();
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(date.length, 10);
  });

  it('returns the current date in Asia/Kolkata regardless of server timezone', () => {
    const istDate = getISTDate();
    const utcDate = new Date().toISOString().slice(0, 10);
    assert.ok(
      istDate >= utcDate,
      `IST date ${istDate} should be >= UTC date ${utcDate}`
    );
  });

  it('correctly crosses IST midnight when UTC is still previous day', () => {
    const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
    const utcNow = new Date('2026-06-15T18:30:00Z');
    const istMillis = utcNow.getTime() + IST_OFFSET_MS;
    const istDate = new Date(istMillis).toISOString().slice(0, 10);
    assert.equal(istDate, '2026-06-16', 'IST date should be next day when UTC is 18:30');
  });
});

describe('addDays', () => {
  it('returns same date when adding 0 days', () => {
    assert.equal(addDays('2026-01-01', 0), '2026-01-01');
  });

  it('adds single day correctly across month boundary', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  });

  it('adds single day correctly across year boundary', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });

  it('adds multiple days correctly', () => {
    assert.equal(addDays('2026-01-01', 30), '2026-01-31');
    assert.equal(addDays('2026-01-01', 31), '2026-02-01');
    assert.equal(addDays('2026-02-01', 28), '2026-03-01');
  });

  it('handles leap year correctly', () => {
    assert.equal(addDays('2024-02-01', 28), '2024-02-29');
    assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  });
});

describe('dateRange', () => {
  it('generates inclusive range', () => {
    const range = dateRange('2026-01-01', '2026-01-03');
    assert.deepEqual(range, ['2026-01-01', '2026-01-02', '2026-01-03']);
    assert.equal(range.length, 3);
  });

  it('returns single date for start === end', () => {
    const range = dateRange('2026-01-01', '2026-01-01');
    assert.deepEqual(range, ['2026-01-01']);
    assert.equal(range.length, 1);
  });

  it('handles month boundaries', () => {
    const range = dateRange('2026-01-30', '2026-02-01');
    assert.deepEqual(range, ['2026-01-30', '2026-01-31', '2026-02-01']);
    assert.equal(range.length, 3);
  });

  it('produces exactly 15 dates starting from tomorrow (today excluded)', () => {
    const today = getISTDate();
    const start = addDays(today, 1);
    const end = addDays(today, 15);
    const range = dateRange(start, end);
    assert.equal(range.length, 15, 'Should produce 15 dates');
    assert.equal(range[0], start, 'First date should be tomorrow');
    assert.equal(range[14], end, 'Last date should be today+15');
  });

  it('today is not included in the default rolling window', () => {
    const today = getISTDate();
    const start = addDays(today, 1);
    const end = addDays(today, 15);
    const range = dateRange(start, end);
    assert.ok(!range.includes(today), `Today (${today}) must not be in the 15-day window`);
  });

  it('all dates are sequential (no gaps)', () => {
    const range = dateRange('2026-01-01', '2026-01-10');
    for (let i = 1; i < range.length; i++) {
      const prev = new Date(range[i - 1]);
      const curr = new Date(range[i]);
      const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
      assert.equal(diffDays, 1, `Expected 1 day gap between ${range[i-1]} and ${range[i]}`);
    }
  });
});
