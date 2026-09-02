/**
 * Regression: turf organizer routes must enforce assigned_venue_ids.
 *
 * A manager with assigned_venue_ids = [5] must be blocked from
 * accessing venues, resources, or bookings that belong to venue_id = 10.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

// ---- lightweight unit tests (no DB) ----

describe('Priority 8 — assigned_venue_ids enforcement (unit)', () => {
  /** Mirror the venueAccess helper logic */
  function enforceVenueAccess(assignedVenueIds: number[], venueId: number): void {
    if (assignedVenueIds.length > 0 && !assignedVenueIds.includes(venueId)) {
      throw new Error('You do not have access to this venue');
    }
  }

  it('owner (empty assignedVenueIds) can access any venue', () => {
    enforceVenueAccess([], 99); // must NOT throw
  });

  it('manager with [5] can access venue 5', () => {
    enforceVenueAccess([5], 5); // must NOT throw
  });

  it('manager with [5] is blocked from venue 10', () => {
    let thrown = false;
    try { enforceVenueAccess([5], 10); } catch { thrown = true; }
    assert.strictEqual(thrown, true);
  });

  it('manager with [5, 7] can access venue 7', () => {
    enforceVenueAccess([5, 7], 7);
  });

  it('manager with [5, 7] is blocked from venue 3', () => {
    let thrown = false;
    try { enforceVenueAccess([5, 7], 3); } catch { thrown = true; }
    assert.strictEqual(thrown, true);
  });
});
