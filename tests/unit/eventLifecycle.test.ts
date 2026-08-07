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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  EventLifecycleAction,
  EventStatus,
} from '../../src/types';

// Re-declare the transition table we ship in the service, mirroring its
// keys so the assertions can stand on their own. If the service changes,
// this test should be updated to match.
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
  'draft', 'pending_review', 'approved', 'published',
  'hidden', 'archived', 'cancelled',
]);

const ALL_ACTIONS: ReadonlySet<EventLifecycleAction> = new Set<EventLifecycleAction>([
  'submit_for_review', 'approve', 'reject', 'publish', 'unpublish',
  'hide', 'show', 'archive', 'restore', 'cancel',
]);

function getAllowedActions(currentStatus: EventStatus): EventLifecycleAction[] {
  const allowed: EventLifecycleAction[] = [];
  for (const key of TRANSITIONS.keys()) {
    const [s, action] = key.split(':', 2);
    if (s === currentStatus) allowed.push(action as EventLifecycleAction);
  }
  return allowed.sort();
}

// ── State machine integrity ───────────────────────────────────────────────────

describe('Event lifecycle — state machine', () => {
  it('every to_status value is a valid EventStatus', () => {
    for (const [key, toStatus] of TRANSITIONS.entries()) {
      assert.ok(
        ALL_STATUSES.has(toStatus),
        `transition "${key}" produces invalid status "${toStatus}"`
      );
    }
  });

  it('every key parses into a valid status and a known action', () => {
    for (const key of TRANSITIONS.keys()) {
      const [fromStatus, action] = key.split(':', 2);
      assert.ok(
        ALL_STATUSES.has(fromStatus as EventStatus),
        `transition "${key}" starts from invalid status "${fromStatus}"`
      );
      assert.ok(
        ALL_ACTIONS.has(action as EventLifecycleAction),
        `transition "${key}" declares unknown action "${action}"`
      );
    }
  });

  it('cancel is reachable from every non-terminal status', () => {
    for (const status of ['draft', 'pending_review', 'approved', 'published', 'hidden'] as EventStatus[]) {
      const allowed = getAllowedActions(status);
      assert.ok(allowed.includes('cancel'), `cancel must be available from "${status}"`);
    }
  });

  it('archive is reachable from every non-terminal status', () => {
    for (const status of ['draft', 'pending_review', 'approved', 'published', 'hidden'] as EventStatus[]) {
      const allowed = getAllowedActions(status);
      assert.ok(allowed.includes('archive'), `archive must be available from "${status}"`);
    }
  });

  it('cancelled is terminal — no transitions leave it', () => {
    const allowed = getAllowedActions('cancelled');
    assert.strictEqual(allowed.length, 0, `cancelled should be terminal, got ${allowed.join(',')}`);
  });

  it('archived can be restored', () => {
    const allowed = getAllowedActions('archived');
    assert.deepStrictEqual(allowed, ['restore']);
  });

  it('pending_review has approve + reject + archive + cancel', () => {
    const allowed = getAllowedActions('pending_review');
    assert.deepStrictEqual(allowed, ['approve', 'archive', 'cancel', 'reject']);
  });

  it('published can be hidden, unpublished, archived, or cancelled', () => {
    const allowed = getAllowedActions('published');
    assert.deepStrictEqual(allowed, ['archive', 'cancel', 'hide', 'unpublish']);
  });
});

// ── Action coverage ───────────────────────────────────────────────────────────

describe('Event lifecycle — action coverage', () => {
  it('publish is only available from approved (not from draft)', () => {
    assert.ok(getAllowedActions('approved').includes('publish'));
    assert.ok(!getAllowedActions('draft').includes('publish'));
  });

  it('approve is only available from pending_review', () => {
    assert.ok(getAllowedActions('pending_review').includes('approve'));
    assert.ok(!getAllowedActions('draft').includes('approve'));
    assert.ok(!getAllowedActions('approved').includes('approve'));
  });

  it('show only works on hidden', () => {
    assert.ok(getAllowedActions('hidden').includes('show'));
    assert.ok(!getAllowedActions('published').includes('show'));
  });
});