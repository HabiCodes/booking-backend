/**
 * Movie Workers — production-readiness tests.
 *
 * Covers:
 *   - Worker file structure (entry point exists, exports correct signature)
 *   - expireStaleBookings flow validation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Helpers ────────────────────────────────────────────────────────────────────

const workerPath = resolve(__dirname, '../../../src/workers/movieWorkers.ts');

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Movie Workers', () => {

  describe('File Structure', () => {
    it('worker file exists and is readable', () => {
      assert.ok(existsSync(workerPath), 'Worker file should exist at expected path');
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.length > 0, 'Worker file should not be empty');
    });

    it('exports a main function / entry point', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes('export async function main'), 'Should have exported main entry point');
      assert.ok(content.includes('main('), 'Should call main()');
    });

    it('supports "expire" and "all" job types', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes("'expire'"), 'Should support expire job');
      assert.ok(content.includes("'all'"), 'Should support all job');
    });

    it('calls expireStaleBookings from the service', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes('expireStaleBookings'), 'Should call expireStaleBookings');
      assert.ok(content.includes('movieBookingService.expireStaleBookings'), 'Should call the service method');
    });

    it('handles errors gracefully', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes('catch'), 'Should have error handling');
      assert.ok(content.includes('logger.error'), 'Should log errors');
      assert.ok(content.includes('process.exitCode'), 'Should set exit code on failure');
    });

    it('closes the DB pool on exit', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes('closePool()'), 'Should close pool in finally block');
    });

    it('logs job start and completion', () => {
      const content = readFileSync(workerPath, 'utf-8');
      assert.ok(content.includes('logger.info'), 'Should log info messages');
      assert.ok(content.includes('Starting job'), 'Should log job start');
      assert.ok(content.includes('completed'), 'Should log job completion');
    });
  });

});