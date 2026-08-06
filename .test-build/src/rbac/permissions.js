"use strict";
/**
 * Granular RBAC — role → permission mapping and helpers.
 *
 * Design:
 *   Each admin has a `permissions` JSONB column storing `{ "events:write": true, ... }`.
 *   The `requirePermission()` middleware checks `req.admin.permissions[perm]`.
 *   On login, the effective permissions are the union of:
 *     a) role defaults (from the map below), and
 *     b) per-admin overrides from the DB.
 *
 * Adding a new permission:
 *   1. Add it to the `PERMISSIONS` tuple below.
 *   2. Add it to the role→default set in `ROLE_DEFAULTS` for every role that gets it.
 *   No other file needs to change.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_DEFAULTS = exports.PERMISSIONS = void 0;
exports.computePermissions = computePermissions;
exports.hasAllPermissions = hasAllPermissions;
exports.hasAnyPermission = hasAnyPermission;
// ── All known permission keys ────────────────────────────────────────────────
exports.PERMISSIONS = [
    'users:read',
    'users:write',
    'users:delete',
    'events:read',
    'events:write',
    'events:delete',
    'events:publish',
    'events:feature',
    'bookings:read',
    'bookings:cancel',
    'bookings:delete',
    'banners:read',
    'banners:write',
    'banners:delete',
    'banners:activate',
    'uploads:read',
    'uploads:write',
    'uploads:delete',
    'scanner:verify',
    'scanner:checkin',
    'admins:read',
    'admins:write',
    'admins:delete',
    'audit:read',
    'analytics:read',
];
// ── Default permissions per role ─────────────────────────────────────────────
exports.ROLE_DEFAULTS = {
    super_admin: new Set(exports.PERMISSIONS),
    admin: new Set([
        'users:read',
        'users:write',
        'events:read',
        'events:write',
        'events:publish',
        'events:feature',
        'bookings:read',
        'bookings:cancel',
        'banners:read',
        'banners:write',
        'banners:activate',
        'uploads:read',
        'uploads:write',
        'scanner:verify',
        'scanner:checkin',
        'analytics:read',
        'audit:read',
    ]),
    event_manager: new Set([
        'events:read',
        'events:write',
        'events:publish',
        'events:feature',
        'bookings:read',
        'bookings:cancel',
        'banners:read',
        'banners:write',
        'banners:activate',
        'uploads:read',
        'uploads:write',
        'analytics:read',
    ]),
    ticket_scanner: new Set([
        'scanner:verify',
        'scanner:checkin',
        'events:read',
    ]),
};
// ── Helpers ──────────────────────────────────────────────────────────────────
/** Compute the effective permissions object for an admin. */
function computePermissions(role, overrides) {
    const defaults = exports.ROLE_DEFAULTS[role] ?? exports.ROLE_DEFAULTS['event_manager'];
    const result = {};
    for (const p of exports.PERMISSIONS) {
        const overrideVal = overrides?.[p];
        result[p] = overrideVal === true ? true : overrideVal === false ? false : defaults.has(p);
    }
    return result;
}
/** Check whether the admin has every permission in the required set. */
function hasAllPermissions(perms, required) {
    if (!perms)
        return false;
    return required.every((p) => !!perms[p]);
}
/** Check whether the admin has any permission in the set. */
function hasAnyPermission(perms, required) {
    if (!perms)
        return false;
    return required.some((p) => !!perms[p]);
}
