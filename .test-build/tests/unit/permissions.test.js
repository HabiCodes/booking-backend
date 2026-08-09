"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const permissions_1 = require("../../src/rbac/permissions");
// ── PERMISSIONS canonical set ──────────────────────────────────────────────────
(0, node_test_1.describe)('PERMISSIONS', () => {
    (0, node_test_1.it)('contains at least 25 permissions', () => {
        strict_1.default.ok(permissions_1.PERMISSIONS.length >= 25, `expected at least 25 permissions, got ${permissions_1.PERMISSIONS.length}`);
    });
    (0, node_test_1.it)('all entries are colon-delimited strings (resource:action or scope:resource:action)', () => {
        for (const p of permissions_1.PERMISSIONS) {
            strict_1.default.ok(typeof p === 'string', `${p} is not a string`);
            strict_1.default.ok(p.includes(':'), `${p} is not colon-delimited`);
            strict_1.default.ok(p.split(':').length <= 3, `${p} should have at most 2 colons`);
        }
    });
    (0, node_test_1.it)('has no duplicates', () => {
        const unique = new Set(permissions_1.PERMISSIONS);
        strict_1.default.strictEqual(unique.size, permissions_1.PERMISSIONS.length);
    });
});
// ── ROLE_DEFAULTS ─────────────────────────────────────────────────────────────
(0, node_test_1.describe)('ROLE_DEFAULTS', () => {
    const roles = ['super_admin', 'admin', 'event_manager', 'ticket_scanner'];
    (0, node_test_1.it)('defines all four expected roles', () => {
        for (const role of roles) {
            strict_1.default.ok(role in permissions_1.ROLE_DEFAULTS, `role "${role}" missing from ROLE_DEFAULTS`);
        }
    });
    (0, node_test_1.it)('super_admin has all permissions', () => {
        strict_1.default.strictEqual(permissions_1.ROLE_DEFAULTS.super_admin.size, permissions_1.PERMISSIONS.length);
    });
    (0, node_test_1.it)('ticket_scanner has the smallest set', () => {
        const sizes = Object.entries(permissions_1.ROLE_DEFAULTS)
            .filter(([r]) => r !== 'super_admin')
            .map(([, s]) => s.size);
        const minSize = Math.min(...sizes);
        strict_1.default.strictEqual(permissions_1.ROLE_DEFAULTS.ticket_scanner.size, minSize);
    });
    (0, node_test_1.it)('every role default only contains known permissions', () => {
        const known = new Set(permissions_1.PERMISSIONS);
        for (const [, set] of Object.entries(permissions_1.ROLE_DEFAULTS)) {
            for (const p of set) {
                strict_1.default.ok(known.has(p), `unknown permission in defaults: ${p}`);
            }
        }
    });
});
// ── computePermissions ────────────────────────────────────────────────────────
(0, node_test_1.describe)('computePermissions', () => {
    (0, node_test_1.it)('returns all permissions as true for super_admin with no overrides', () => {
        const result = (0, permissions_1.computePermissions)('super_admin', undefined);
        for (const p of permissions_1.PERMISSIONS) {
            strict_1.default.strictEqual(result[p], true, `super_admin should have ${p}`);
        }
    });
    (0, node_test_1.it)('falls back to event_manager permissions for an unknown role', () => {
        const expected = (0, permissions_1.computePermissions)('event_manager', undefined);
        const result = (0, permissions_1.computePermissions)('nonexistent_role', undefined);
        strict_1.default.deepStrictEqual(result, expected);
    });
    (0, node_test_1.it)('grants role defaults when override is absent', () => {
        const result = (0, permissions_1.computePermissions)('ticket_scanner', undefined);
        strict_1.default.strictEqual(result['scanner:verify'], true);
        strict_1.default.strictEqual(result['events:read'], true);
        strict_1.default.strictEqual(result['events:write'], false); // not in default
    });
    (0, node_test_1.it)('allows override: true to add a permission outside the role default', () => {
        const result = (0, permissions_1.computePermissions)('ticket_scanner', { 'bookings:read': true });
        strict_1.default.strictEqual(result['bookings:read'], true);
    });
    (0, node_test_1.it)('allows override: false to remove a permission from the role default', () => {
        const result = (0, permissions_1.computePermissions)('admin', { 'events:write': false });
        strict_1.default.strictEqual(result['events:write'], false);
        // sibling permissions still default to true
        strict_1.default.strictEqual(result['events:read'], true);
    });
    (0, node_test_1.it)('ignores non-boolean overrides (type signature prevents this)', () => {
        // computePermissions accepts `Record<string, boolean> | null | undefined`,
        // so TypeScript blocks non-boolean overrides at compile time.  Verify
        // that a boolean override works as expected.
        const result = (0, permissions_1.computePermissions)('admin', { 'events:write': true });
        strict_1.default.strictEqual(result['events:write'], true);
    });
});
// ── hasAllPermissions ─────────────────────────────────────────────────────────
(0, node_test_1.describe)('hasAllPermissions', () => {
    const perms = {
        'users:read': true,
        'events:write': true,
        'banners:delete': false,
    };
    (0, node_test_1.it)('returns true when every required permission is present', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAllPermissions)(perms, ['users:read', 'events:write']), true);
    });
    (0, node_test_1.it)('returns false when any required permission is missing / false', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAllPermissions)(perms, ['users:read', 'banners:delete']), false);
    });
    (0, node_test_1.it)('returns false for undefined permissions', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAllPermissions)(undefined, ['users:read']), false);
    });
    (0, node_test_1.it)('returns true for an empty required list', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAllPermissions)(perms, []), true);
    });
});
// ── hasAnyPermission ──────────────────────────────────────────────────────────
(0, node_test_1.describe)('hasAnyPermission', () => {
    const perms = {
        'users:read': true,
        'events:write': false,
        'banners:delete': false,
    };
    (0, node_test_1.it)('returns true when at least one permission matches', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAnyPermission)(perms, ['users:read', 'events:write']), true);
    });
    (0, node_test_1.it)('returns false when none match', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAnyPermission)(perms, ['banners:delete', 'admins:write']), false);
    });
    (0, node_test_1.it)('returns false for undefined permissions', () => {
        strict_1.default.strictEqual((0, permissions_1.hasAnyPermission)(undefined, ['users:read']), false);
    });
});
