"use strict";
/**
 * Granular RBAC — role → permission mapping and helpers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_DEFAULTS = exports.PERMISSIONS = void 0;
exports.computePermissions = computePermissions;
exports.hasAllPermissions = hasAllPermissions;
exports.hasAnyPermission = hasAnyPermission;
exports.PERMISSIONS = [
    // Platform admin
    'users:read', 'users:write', 'users:delete',
    'events:read', 'events:write', 'events:delete', 'events:publish', 'events:feature',
    'bookings:read', 'bookings:cancel', 'bookings:delete',
    'banners:read', 'banners:write', 'banners:delete', 'banners:activate',
    'uploads:read', 'uploads:write', 'uploads:delete',
    'media:read', 'media:write', 'media:delete',
    'scanner:verify', 'scanner:checkin',
    'admins:read', 'admins:write', 'admins:delete',
    'audit:read', 'analytics:read',
    // Organizer / partner platform
    'organizer:applications:read', 'organizer:applications:approve', 'organizer:applications:reject', 'organizer:applications:reopen',
    'organizer:events:read', 'organizer:events:write', 'organizer:events:approve',
    'organizer:bookings:read', 'organizer:bookings:cancel', 'organizer:bookings:write',
    'organizer:tickets:read', 'organizer:tickets:scan', 'organizer:tickets:checkin',
    'organizer:venues:read', 'organizer:venues:write',
    'organizer:tiers:read', 'organizer:tiers:write',
    'organizer:seats:read', 'organizer:seats:write',
    'organizer:analytics:read',
    'organizer:staff:read', 'organizer:staff:write', 'organizer:staff:delete',
    'organizer:profile:read', 'organizer:profile:write',
    'organizer:banking:read', 'organizer:banking:write',
    'organizer:payments:read', 'organizer:payments:write', 'organizer:payments:refund',
];
exports.ROLE_DEFAULTS = {
    super_admin: new Set(exports.PERMISSIONS),
    admin: new Set([
        'users:read', 'users:write',
        'events:read', 'events:write', 'events:publish', 'events:feature',
        'bookings:read', 'bookings:cancel',
        'banners:read', 'banners:write', 'banners:activate',
        'uploads:read', 'uploads:write',
        'media:read', 'media:write', 'media:delete',
        'scanner:verify', 'scanner:checkin',
        'analytics:read', 'audit:read',
        'organizer:applications:read', 'organizer:events:read', 'organizer:bookings:read',
        'organizer:analytics:read', 'organizer:payments:read',
        'organizer:venues:read',
    ]),
    event_manager: new Set([
        'events:read', 'events:write', 'events:publish', 'events:feature',
        'bookings:read', 'bookings:cancel',
        'banners:read', 'banners:write', 'banners:activate',
        'uploads:read', 'uploads:write',
        'media:read', 'media:write',
        'analytics:read',
    ]),
    ticket_scanner: new Set([
        'scanner:verify', 'scanner:checkin', 'events:read',
    ]),
};
function computePermissions(role, overrides) {
    const defaults = exports.ROLE_DEFAULTS[role] ?? exports.ROLE_DEFAULTS['event_manager'];
    const result = {};
    for (const p of exports.PERMISSIONS) {
        const overrideVal = overrides?.[p];
        result[p] = overrideVal === true ? true : overrideVal === false ? false : defaults.has(p);
    }
    return result;
}
function hasAllPermissions(perms, required) {
    if (!perms)
        return false;
    return required.every((p) => !!perms[p]);
}
function hasAnyPermission(perms, required) {
    if (!perms)
        return false;
    return required.some((p) => !!perms[p]);
}
