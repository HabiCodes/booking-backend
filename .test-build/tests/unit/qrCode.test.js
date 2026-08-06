"use strict";
/**
 * Unit tests for src/utils/qrCode.ts
 *
 * Covers QR payload signing, verification, and tamper detection.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const qrCode_1 = require("../../src/utils/qrCode");
(0, node_test_1.describe)('qrCode', () => {
    const ticket = { ticket_uuid: 'uuid-123-abc' };
    const eventId = 42;
    const eventStartAt = '2026-12-01T18:00:00Z';
    (0, node_test_1.describe)('signTicket / verifyTicketSignature', () => {
        (0, node_test_1.it)('signs and verifies a payload round-trip', () => {
            const signature = (0, qrCode_1.signTicket)(ticket, eventId, eventStartAt);
            strict_1.default.strictEqual(typeof signature, 'string');
            strict_1.default.ok(/^[a-f0-9]+$/.test(signature)); // hex
            strict_1.default.strictEqual(signature.length, 64); // SHA-256 hex digest
            const result = (0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, signature);
            strict_1.default.strictEqual(result.valid, true);
            strict_1.default.strictEqual(result.reason, undefined);
        });
        (0, node_test_1.it)('returns invalid for an empty / missing signature', () => {
            strict_1.default.strictEqual((0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, '').valid, false);
            strict_1.default.strictEqual((0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, null).valid, false);
            strict_1.default.strictEqual((0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, undefined).valid, false);
        });
        (0, node_test_1.it)('returns invalid for a wrong-length signature', () => {
            const result = (0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, 'abc');
            strict_1.default.strictEqual(result.valid, false);
            strict_1.default.ok(String(result.reason).match(/length/i));
        });
        (0, node_test_1.it)('returns invalid for a tampered signature', () => {
            const sig = (0, qrCode_1.signTicket)(ticket, eventId, eventStartAt);
            // Flip a hex char in the middle
            const tampered = sig.slice(0, 32) + (sig[32] === 'a' ? 'b' : 'a') + sig.slice(33);
            const result = (0, qrCode_1.verifyTicketSignature)(ticket, eventId, eventStartAt, tampered);
            strict_1.default.strictEqual(result.valid, false);
            strict_1.default.ok(String(result.reason).match(/tamper|mismatch/i));
        });
        (0, node_test_1.it)('returns invalid when the ticket uuid has been altered', () => {
            const sig = (0, qrCode_1.signTicket)(ticket, eventId, eventStartAt);
            const alteredTicket = { ticket_uuid: 'uuid-456-xyz' };
            const result = (0, qrCode_1.verifyTicketSignature)(alteredTicket, eventId, eventStartAt, sig);
            strict_1.default.strictEqual(result.valid, false);
        });
        (0, node_test_1.it)('returns invalid when eventId is altered', () => {
            const sig = (0, qrCode_1.signTicket)(ticket, eventId, eventStartAt);
            const result = (0, qrCode_1.verifyTicketSignature)(ticket, eventId + 1, eventStartAt, sig);
            strict_1.default.strictEqual(result.valid, false);
        });
        (0, node_test_1.it)('returns invalid when eventStartAt is altered', () => {
            const sig = (0, qrCode_1.signTicket)(ticket, eventId, eventStartAt);
            const result = (0, qrCode_1.verifyTicketSignature)(ticket, eventId, '2099-01-01T00:00:00Z', sig);
            strict_1.default.strictEqual(result.valid, false);
        });
    });
    (0, node_test_1.describe)('generateTicketReference', () => {
        (0, node_test_1.it)('returns a string in TKT-XXXX-XXXX format', () => {
            const ref = (0, qrCode_1.generateTicketReference)();
            strict_1.default.ok(/^TKT-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(ref));
        });
        (0, node_test_1.it)('produces unique references on repeated calls', () => {
            const refs = new Set();
            for (let i = 0; i < 100; i++) {
                refs.add((0, qrCode_1.generateTicketReference)());
            }
            strict_1.default.ok(refs.size > 90);
        });
    });
});
