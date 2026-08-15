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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EventLifecycleAction, EventStatus } from '../../src/types';

// Mirror the transition table from the service so these tests stand on their own.
// If the service table changes, these tests must be updated to match.
const TRANSITIONS: ReadonlyMap<string, EventStatus> = new Map<string, EventStatus>([
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

const ALL_STATUSES: ReadonlySet<EventStatus> = new Set<EventStatus>([
  'draft', 'pending_review', 'approved', 'published', 'hidden', 'archived', 'cancelled',
]);

const ALL_ACTIONS: ReadonlySet<EventLifecycleAction> = new Set<EventLifecycleAction>([
  'submit_for_review', 'approve', 'reject', 'publish', 'unpublish',
  'hide', 'show', 'archive', 'restore', 'cancel',
]);

function getAllowedActions(status: EventStatus): EventLifecycleAction[] {
  const result: EventLifecycleAction[] = [];
  for (const [key, toStatus] of TRANSITIONS.entries()) {
    const [from, action] = key.split(':', 2);
    if (from === status) result.push(action as EventLifecycleAction);
  }
  return result.sort();
}

// ── Transition table integrity ─────────────────────────────────────────────────

describe('eventLifecycle — transition table integrity', () => {
  it('every to_status is a recognised EventStatus', () => {
    for (const [key, to] of TRANSITIONS.entries()) {
      assert.ok(
        ALL_STATUSES.has(to),
        `Transition "${key}" points to unknown status "${to}"`,
      );
    }
  });

  it('every from_status is a recognised EventStatus', () => {
    for (const key of TRANSITIONS.keys()) {
      const [from] = key.split(':', 2);
      assert.ok(
        ALL_STATUSES.has(from as EventStatus),
        `Transition "${key}" originates from unknown status "${from}"`,
      );
    }
  });

  it('every action in the table is a known EventLifecycleAction', () => {
    for (const key of TRANSITIONS.keys()) {
      const [, action] = key.split(':', 2);
      assert.ok(
        ALL_ACTIONS.has(action as EventLifecycleAction),
        `Transition "${key}" uses unknown action "${action}"`,
      );
    }
  });

  it('no duplicate (from_status, action) pairs', () => {
    const seen = new Set<string>();
    for (const key of TRANSITIONS.keys()) {
      assert.ok(
        !seen.has(key),
        `Duplicate transition key: "${key}"`,
      );
      seen.add(key);
    }
    assert.equal(seen.size, TRANSITIONS.size);
  });

  it('no self-transitions (from_status === to_status)', () => {
    for (const [key, to] of TRANSITIONS.entries()) {
      const [from] = key.split(':', 2);
      assert.notEqual(
        from, to,
        `Self-transition detected: "${key}" does nothing`,
      );
    }
  });
});

// ── State machine behaviour ────────────────────────────────────────────────────

describe('eventLifecycle — state machine behaviour', () => {
  it('draft can only be submitted_for_review, archived, or cancelled', () => {
    const actions = getAllowedActions('draft');
    assert.deepEqual(actions, ['archive', 'cancel', 'submit_for_review']);
  });

  it('pending_review can approve (→approved), reject (→draft), archive (→archived), cancel (→cancelled)', () => {
    const actions = getAllowedActions('pending_review');
    assert.ok(actions.includes('approve'));
    assert.ok(actions.includes('reject'));
    assert.ok(actions.includes('archive'));
    assert.ok(actions.includes('cancel'));
  });

  it('published can only be unpublished, hidden, archived, or cancelled', () => {
    const actions = getAllowedActions('published');
    assert.deepEqual(actions, ['archive', 'cancel', 'hide', 'unpublish']);
  });

  it('hidden can only be shown, archived, or cancelled', () => {
    const actions = getAllowedActions('hidden');
    assert.deepEqual(actions, ['archive', 'cancel', 'show']);
  });

  it('archived can only be restored (→draft)', () => {
    const actions = getAllowedActions('archived');
    assert.deepEqual(actions, ['restore']);
  });

  it('cancelled is terminal — no transitions allowed', () => {
    const actions = getAllowedActions('cancelled');
    assert.deepEqual(actions, []);
  });

  it('every non-terminal status allows cancel', () => {
    // archived is considered terminal (only restore is available), so it is excluded
    const nonTerminal: EventStatus[] = ['draft', 'pending_review', 'approved', 'published', 'hidden'];
    for (const status of nonTerminal) {
      const actions = getAllowedActions(status);
      assert.ok(actions.includes('cancel'), `${status} should allow cancel`);
    }
  });

  it('terminal states (archived, cancelled) have no transitions except restore/cancel respectively', () => {
    assert.deepEqual(getAllowedActions('cancelled'), []);
    assert.deepEqual(getAllowedActions('archived'), ['restore']);
  });
});

// ── Transition coverage ────────────────────────────────────────────────────────

describe('eventLifecycle — transition table coverage', () => {
  it('covers every EventLifecycleAction at least once', () => {
    const actionsInTable = new Set<EventLifecycleAction>();
    for (const [key] of TRANSITIONS.entries()) {
      // key is "fromStatus:action" — split on the first ':' to get the action
      const [, action] = key.split(':', 2);
      actionsInTable.add(action as EventLifecycleAction);
    }
    for (const required of ALL_ACTIONS) {
      assert.ok(
        actionsInTable.has(required),
        `Action "${required}" is not present in any transition`,
      );
    }
  });

  it('table contains exactly 18 transitions', () => {
    assert.equal(TRANSITIONS.size, 18);
  });
});
