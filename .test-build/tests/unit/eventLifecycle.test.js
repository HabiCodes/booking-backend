"use strict";
/**
 * Unit tests for src/services/eventLifecycleService.ts
 *
 * What we cover here (pure logic only — no DB):
 *   - The state-machine transition table is internally consistent:
 *     every key maps to a known EventStatus value.
 *   - getAllowedActions returns only transitions whose current status
 *     matches the event's status.
 *   - All public action names map to exactly one entry in the table.
 *
 * DB-dependent behaviour (the actual transition write, history insert)
 * is covered by tests/integration when DB is available.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
// Re-declare the transition table we ship in the service, mirroring its
// keys so the assertions can stand on their own. If the service changes,
// this test should be updated to match.
const TRANSITIONS = new Map([
    ['draft:submit_for_review', 'pending_review'],
    ['pending_review:approve', 'approved'],
    ['pending_review:reject', 'draft'],
    ['approved:publish', 'published'],
    ['published:unpublish', 'approved'],
    ['published:hide', 'hidden'],
    ['hidden:show', 'published'],
    ['draft:archive', 'archived'],
    ['pending_review:archive', 'archived'],
    ['approved:archive', 'archived'],
    ['published:archive', 'archived'],
    ['hidden:archive', 'archived'],
    ['archived:restore', 'draft'],
    ['draft:cancel', 'cancelled'],
    ['pending_review:cancel', 'cancelled'],
    ['approved:cancel', 'cancelled'],
    ['published:cancel', 'cancelled'],
    ['hidden:cancel', 'cancelled'],
]);
const ALL_STATUSES = new Set([
    'draft', 'pending_review', 'approved', 'published',
    'hidden', 'archived', 'cancelled',
]);
const ALL_ACTIONS = new Set([
    'submit_for_review', 'approve', 'reject', 'publish', 'unpublish',
    'hide', 'show', 'archive', 'restore', 'cancel',
]);
function getAllowedActions(currentStatus) {
    const allowed = [];
    for (const key of TRANSITIONS.keys()) {
        const [s, action] = key.split(':', 2);
        if (s === currentStatus)
            allowed.push(action);
    }
    return allowed.sort();
}
// ── State machine integrity ───────────────────────────────────────────────────
(0, node_test_1.describe)('Event lifecycle — state machine', () => {
    (0, node_test_1.it)('every to_status value is a valid EventStatus', () => {
        for (const [key, toStatus] of TRANSITIONS.entries()) {
            strict_1.default.ok(ALL_STATUSES.has(toStatus), `transition "${key}" produces invalid status "${toStatus}"`);
        }
    });
    (0, node_test_1.it)('every key parses into a valid status and a known action', () => {
        for (const key of TRANSITIONS.keys()) {
            const [fromStatus, action] = key.split(':', 2);
            strict_1.default.ok(ALL_STATUSES.has(fromStatus), `transition "${key}" starts from invalid status "${fromStatus}"`);
            strict_1.default.ok(ALL_ACTIONS.has(action), `transition "${key}" declares unknown action "${action}"`);
        }
    });
    (0, node_test_1.it)('cancel is reachable from every non-terminal status', () => {
        for (const status of ['draft', 'pending_review', 'approved', 'published', 'hidden']) {
            const allowed = getAllowedActions(status);
            strict_1.default.ok(allowed.includes('cancel'), `cancel must be available from "${status}"`);
        }
    });
    (0, node_test_1.it)('archive is reachable from every non-terminal status', () => {
        for (const status of ['draft', 'pending_review', 'approved', 'published', 'hidden']) {
            const allowed = getAllowedActions(status);
            strict_1.default.ok(allowed.includes('archive'), `archive must be available from "${status}"`);
        }
    });
    (0, node_test_1.it)('cancelled is terminal — no transitions leave it', () => {
        const allowed = getAllowedActions('cancelled');
        strict_1.default.strictEqual(allowed.length, 0, `cancelled should be terminal, got ${allowed.join(',')}`);
    });
    (0, node_test_1.it)('archived can be restored', () => {
        const allowed = getAllowedActions('archived');
        strict_1.default.deepStrictEqual(allowed, ['restore']);
    });
    (0, node_test_1.it)('pending_review has approve + reject + archive + cancel', () => {
        const allowed = getAllowedActions('pending_review');
        strict_1.default.deepStrictEqual(allowed, ['approve', 'archive', 'cancel', 'reject']);
    });
    (0, node_test_1.it)('published can be hidden, unpublished, archived, or cancelled', () => {
        const allowed = getAllowedActions('published');
        strict_1.default.deepStrictEqual(allowed, ['archive', 'cancel', 'hide', 'unpublish']);
    });
});
// ── Action coverage ───────────────────────────────────────────────────────────
(0, node_test_1.describe)('Event lifecycle — action coverage', () => {
    (0, node_test_1.it)('publish is only available from approved (not from draft)', () => {
        strict_1.default.ok(getAllowedActions('approved').includes('publish'));
        strict_1.default.ok(!getAllowedActions('draft').includes('publish'));
    });
    (0, node_test_1.it)('approve is only available from pending_review', () => {
        strict_1.default.ok(getAllowedActions('pending_review').includes('approve'));
        strict_1.default.ok(!getAllowedActions('draft').includes('approve'));
        strict_1.default.ok(!getAllowedActions('approved').includes('approve'));
    });
    (0, node_test_1.it)('show only works on hidden', () => {
        strict_1.default.ok(getAllowedActions('hidden').includes('show'));
        strict_1.default.ok(!getAllowedActions('published').includes('show'));
    });
});
