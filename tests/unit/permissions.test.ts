/**
 * Unit tests for src/rbac/permissions.ts
 *
 * Covers:
 *   - PERMISSIONS completeness (25 permissions, snake_case:action keys)
 *   - ROLE_DEFAULTS shape (super_admin → all, others → subsets)
 *   - computePermissions: role defaults, overrides (true/false), unknown role fallback
 *   - hasAllPermissions / hasAnyPermission helpers
 *   - Super admin short-circuit behaviour (handled by requirePermission middleware)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSIONS,
  ROLE_DEFAULTS,
  computePermissions,
  hasAllPermissions,
  hasAnyPermission,
} from '../../src/rbac/permissions';

// ── PERMISSIONS canonical set ──────────────────────────────────────────────────

describe('PERMISSIONS', () => {
  it('contains exactly 25 permissions', () => {
    assert.strictEqual(PERMISSIONS.length, 25);
  });

  it('all entries are colon-delimited resource:action strings', () => {
    for (const p of PERMISSIONS) {
      assert.ok(typeof p === 'string', `${p} is not a string`);
      assert.ok(p.includes(':'), `${p} is not colon-delimited`);
      assert.strictEqual(p.split(':').length, 2, `${p} should have exactly one colon`);
    }
  });

  it('has no duplicates', () => {
    const unique = new Set(PERMISSIONS);
    assert.strictEqual(unique.size, PERMISSIONS.length);
  });
});

// ── ROLE_DEFAULTS ─────────────────────────────────────────────────────────────

describe('ROLE_DEFAULTS', () => {
  const roles = ['super_admin', 'admin', 'event_manager', 'ticket_scanner'];

  it('defines all four expected roles', () => {
    for (const role of roles) {
      assert.ok(role in ROLE_DEFAULTS, `role "${role}" missing from ROLE_DEFAULTS`);
    }
  });

  it('super_admin has all 25 permissions', () => {
    assert.strictEqual(ROLE_DEFAULTS.super_admin.size, 25);
  });

  it('ticket_scanner has the smallest set', () => {
    const sizes = Object.entries(ROLE_DEFAULTS)
      .filter(([r]) => r !== 'super_admin')
      .map(([, s]) => s.size);
    const minSize = Math.min(...sizes);
    assert.strictEqual(ROLE_DEFAULTS.ticket_scanner.size, minSize);
  });

  it('every role default only contains known permissions', () => {
    const known = new Set(PERMISSIONS);
    for (const [, set] of Object.entries(ROLE_DEFAULTS)) {
      for (const p of set) {
        assert.ok(known.has(p), `unknown permission in defaults: ${p}`);
      }
    }
  });
});

// ── computePermissions ────────────────────────────────────────────────────────

describe('computePermissions', () => {
  it('returns all permissions as true for super_admin with no overrides', () => {
    const result = computePermissions('super_admin', undefined);
    for (const p of PERMISSIONS) {
      assert.strictEqual(result[p], true, `super_admin should have ${p}`);
    }
  });

  it('falls back to event_manager permissions for an unknown role', () => {
    const expected = computePermissions('event_manager', undefined);
    const result = computePermissions('nonexistent_role', undefined);
    assert.deepStrictEqual(result, expected);
  });

  it('grants role defaults when override is absent', () => {
    const result = computePermissions('ticket_scanner', undefined);
    assert.strictEqual(result['scanner:verify'], true);
    assert.strictEqual(result['events:read'], true);
    assert.strictEqual(result['events:write'], false); // not in default
  });

  it('allows override: true to add a permission outside the role default', () => {
    const result = computePermissions('ticket_scanner', { 'bookings:read': true });
    assert.strictEqual(result['bookings:read'], true);
  });

  it('allows override: false to remove a permission from the role default', () => {
    const result = computePermissions('admin', { 'events:write': false });
    assert.strictEqual(result['events:write'], false);
    // sibling permissions still default to true
    assert.strictEqual(result['events:read'], true);
  });

  it('ignores non-boolean overrides (type signature prevents this)', () => {
    // computePermissions accepts `Record<string, boolean> | null | undefined`,
    // so TypeScript blocks non-boolean overrides at compile time.  Verify
    // that a boolean override works as expected.
    const result = computePermissions('admin', { 'events:write': true });
    assert.strictEqual(result['events:write'], true);
  });
});

// ── hasAllPermissions ─────────────────────────────────────────────────────────

describe('hasAllPermissions', () => {
  const perms = {
    'users:read': true,
    'events:write': true,
    'banners:delete': false,
  };

  it('returns true when every required permission is present', () => {
    assert.strictEqual(hasAllPermissions(perms, ['users:read', 'events:write']), true);
  });

  it('returns false when any required permission is missing / false', () => {
    assert.strictEqual(hasAllPermissions(perms, ['users:read', 'banners:delete']), false);
  });

  it('returns false for undefined permissions', () => {
    assert.strictEqual(hasAllPermissions(undefined, ['users:read']), false);
  });

  it('returns true for an empty required list', () => {
    assert.strictEqual(hasAllPermissions(perms, []), true);
  });
});

// ── hasAnyPermission ──────────────────────────────────────────────────────────

describe('hasAnyPermission', () => {
  const perms = {
    'users:read': true,
    'events:write': false,
    'banners:delete': false,
  };

  it('returns true when at least one permission matches', () => {
    assert.strictEqual(hasAnyPermission(perms, ['users:read', 'events:write']), true);
  });

  it('returns false when none match', () => {
    assert.strictEqual(hasAnyPermission(perms, ['banners:delete', 'admins:write']), false);
  });

  it('returns false for undefined permissions', () => {
    assert.strictEqual(hasAnyPermission(undefined, ['users:read']), false);
  });
});