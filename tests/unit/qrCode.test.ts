/**
 * Unit tests for src/utils/qrCode.ts
 *
 * Covers QR payload signing, verification, and tamper detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signTicket, verifyTicketSignature, generateTicketReference } from '../../src/utils/qrCode';

describe('qrCode', () => {
  const ticket = { ticket_uuid: 'uuid-123-abc' };
  const eventId = 42;
  const eventStartAt = '2026-12-01T18:00:00Z';

  describe('signTicket / verifyTicketSignature', () => {
    it('signs and verifies a payload round-trip', () => {
      const signature = signTicket(ticket, eventId, eventStartAt);
      assert.strictEqual(typeof signature, 'string');
      assert.ok(/^[a-f0-9]+$/.test(signature)); // hex
      assert.strictEqual(signature.length, 64); // SHA-256 hex digest

      const result = verifyTicketSignature(ticket, eventId, eventStartAt, signature);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.reason, undefined);
    });

    it('returns invalid for an empty / missing signature', () => {
      assert.strictEqual(verifyTicketSignature(ticket, eventId, eventStartAt, '').valid, false);
      assert.strictEqual(verifyTicketSignature(ticket, eventId, eventStartAt, null).valid, false);
      assert.strictEqual(verifyTicketSignature(ticket, eventId, eventStartAt, undefined).valid, false);
    });

    it('returns invalid for a wrong-length signature', () => {
      const result = verifyTicketSignature(ticket, eventId, eventStartAt, 'abc');
      assert.strictEqual(result.valid, false);
      assert.ok(String(result.reason).match(/length/i));
    });

    it('returns invalid for a tampered signature', () => {
      const sig = signTicket(ticket, eventId, eventStartAt);
      // Flip a hex char in the middle
      const tampered = sig.slice(0, 32) + (sig[32] === 'a' ? 'b' : 'a') + sig.slice(33);
      const result = verifyTicketSignature(ticket, eventId, eventStartAt, tampered);
      assert.strictEqual(result.valid, false);
      assert.ok(String(result.reason).match(/tamper|mismatch/i));
    });

    it('returns invalid when the ticket uuid has been altered', () => {
      const sig = signTicket(ticket, eventId, eventStartAt);
      const alteredTicket = { ticket_uuid: 'uuid-456-xyz' };
      const result = verifyTicketSignature(alteredTicket, eventId, eventStartAt, sig);
      assert.strictEqual(result.valid, false);
    });

    it('returns invalid when eventId is altered', () => {
      const sig = signTicket(ticket, eventId, eventStartAt);
      const result = verifyTicketSignature(ticket, eventId + 1, eventStartAt, sig);
      assert.strictEqual(result.valid, false);
    });

    it('returns invalid when eventStartAt is altered', () => {
      const sig = signTicket(ticket, eventId, eventStartAt);
      const result = verifyTicketSignature(ticket, eventId, '2099-01-01T00:00:00Z', sig);
      assert.strictEqual(result.valid, false);
    });
  });

  describe('generateTicketReference', () => {
    it('returns a string in TKT-XXXX-XXXX format', () => {
      const ref = generateTicketReference();
      assert.ok(/^TKT-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(ref));
    });

    it('produces unique references on repeated calls', () => {
      const refs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        refs.add(generateTicketReference());
      }
      assert.ok(refs.size > 90);
    });
  });
});