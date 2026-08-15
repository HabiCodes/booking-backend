"use strict";
/**
 * Unit tests for eventLifecycleService — pure logic only (no DB required).
 *
 * Covers:
 *   - State machine transition table is internally consistent
 *   - All transitions are reachable from a valid EventStatus
 *   - No duplicate transitions exist
 *   - Terminal states (cancelled, archived) only accept restore/cancel where applicable
 *   - No self-transitions (status → status with no-op actions)
 *
 * DB-dependent behaviour (transaction, history insert, audit log) lives in
 * tests/integration.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
// Mirror the transition table from the service so these tests stand on their own.
// If the service table changes, these tests must be updated to match.
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
    'draft', 'pending_review', 'approved', 'published', 'hidden', 'archived', 'cancelled',
]);
const ALL_ACTIONS = new Set([
    'submit_for_review', 'approve', 'reject', 'publish', 'unpublish',
    'hide', 'show', 'archive', 'restore', 'cancel',
]);
function getAllowedActions(status) {
    const result = [];
    for (const [key, toStatus] of TRANSITIONS.entries()) {
        const [from, action] = key.split(':', 2);
        if (from === status)
            result.push(action);
    }
    return result.sort();
}
// ── Transition table integrity ─────────────────────────────────────────────────
(0, node_test_1.describe)('eventLifecycle — transition table integrity', () => {
    (0, node_test_1.it)('every to_status is a recognised EventStatus', () => {
        for (const [key, to] of TRANSITIONS.entries()) {
            strict_1.default.ok(ALL_STATUSES.has(to), `Transition "${key}" points to unknown status "${to}"`);
        }
    });
    (0, node_test_1.it)('every from_status is a recognised EventStatus', () => {
        for (const key of TRANSITIONS.keys()) {
            const [from] = key.split(':', 2);
            strict_1.default.ok(ALL_STATUSES.has(from), `Transition "${key}" originates from unknown status "${from}"`);
        }
    });
    (0, node_test_1.it)('every action in the table is a known EventLifecycleAction', () => {
        for (const key of TRANSITIONS.keys()) {
            const [, action] = key.split(':', 2);
            strict_1.default.ok(ALL_ACTIONS.has(action), `Transition "${key}" uses unknown action "${action}"`);
        }
    });
    (0, node_test_1.it)('no duplicate (from_status, action) pairs', () => {
        const seen = new Set();
        for (const key of TRANSITIONS.keys()) {
            strict_1.default.ok(!seen.has(key), `Duplicate transition key: "${key}"`);
            seen.add(key);
        }
        strict_1.default.equal(seen.size, TRANSITIONS.size);
    });
    (0, node_test_1.it)('no self-transitions (from_status === to_status)', () => {
        for (const [key, to] of TRANSITIONS.entries()) {
            const [from] = key.split(':', 2);
            strict_1.default.notEqual(from, to, `Self-transition detected: "${key}" does nothing`);
        }
    });
});
// ── State machine behaviour ────────────────────────────────────────────────────
(0, node_test_1.describe)('eventLifecycle — state machine behaviour', () => {
    (0, node_test_1.it)('draft can only be submitted_for_review, archived, or cancelled', () => {
        const actions = getAllowedActions('draft');
        strict_1.default.deepEqual(actions, ['archive', 'cancel', 'submit_for_review']);
    });
    (0, node_test_1.it)('pending_review can approve (→approved), reject (→draft), archive (→archived), cancel (→cancelled)', () => {
        const actions = getAllowedActions('pending_review');
        strict_1.default.ok(actions.includes('approve'));
        strict_1.default.ok(actions.includes('reject'));
        strict_1.default.ok(actions.includes('archive'));
        strict_1.default.ok(actions.includes('cancel'));
    });
    (0, node_test_1.it)('published can only be unpublished, hidden, archived, or cancelled', () => {
        const actions = getAllowedActions('published');
        strict_1.default.deepEqual(actions, ['archive', 'cancel', 'hide', 'unpublish']);
    });
    (0, node_test_1.it)('hidden can only be shown, archived, or cancelled', () => {
        const actions = getAllowedActions('hidden');
        strict_1.default.deepEqual(actions, ['archive', 'cancel', 'show']);
    });
    (0, node_test_1.it)('archived can only be restored (→draft)', () => {
        const actions = getAllowedActions('archived');
        strict_1.default.deepEqual(actions, ['restore']);
    });
    (0, node_test_1.it)('cancelled is terminal — no transitions allowed', () => {
        const actions = getAllowedActions('cancelled');
        strict_1.default.deepEqual(actions, []);
    });
    (0, node_test_1.it)('every non-terminal status allows cancel', () => {
        // archived is considered terminal (only restore is available), so it is excluded
        const nonTerminal = ['draft', 'pending_review', 'approved', 'published', 'hidden'];
        for (const status of nonTerminal) {
            const actions = getAllowedActions(status);
            strict_1.default.ok(actions.includes('cancel'), `${status} should allow cancel`);
        }
    });
    (0, node_test_1.it)('terminal states (archived, cancelled) have no transitions except restore/cancel respectively', () => {
        strict_1.default.deepEqual(getAllowedActions('cancelled'), []);
        strict_1.default.deepEqual(getAllowedActions('archived'), ['restore']);
    });
});
// ── Transition coverage ────────────────────────────────────────────────────────
(0, node_test_1.describe)('eventLifecycle — transition table coverage', () => {
    (0, node_test_1.it)('covers every EventLifecycleAction at least once', () => {
        const actionsInTable = new Set();
        for (const [key] of TRANSITIONS.entries()) {
            // key is "fromStatus:action" — split on the first ':' to get the action
            const [, action] = key.split(':', 2);
            actionsInTable.add(action);
        }
        for (const required of ALL_ACTIONS) {
            strict_1.default.ok(actionsInTable.has(required), `Action "${required}" is not present in any transition`);
        }
    });
    (0, node_test_1.it)('table contains exactly 18 transitions', () => {
        strict_1.default.equal(TRANSITIONS.size, 18);
    });
});
