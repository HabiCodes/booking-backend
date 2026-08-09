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

import type { AdminPermission } from '../types';

// ── All known permission keys ────────────────────────────────────────────────

export const PERMISSIONS: readonly AdminPermission[] = [
  // ── Platform admin ──────────────────────────────────────────────────────────
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
  'media:read',
  'media:write',
  'media:delete',
  'scanner:verify',
  'scanner:checkin',
  'admins:read',
  'admins:write',
  'admins:delete',
  'audit:read',
  'analytics:read',

  // ── Organizer / partner platform ────────────────────────────────────────────
  'organizer:applications:read',
  'organizer:applications:approve',
  'organizer:applications:reject',
  'organizer:applications:reopen',
  'organizer:events:read',
  'organizer:events:write',
  'organizer:events:approve',
  'organizer:bookings:read',
  'organizer:bookings:cancel',
  'organizer:bookings:write',
  'organizer:tickets:read',
  'organizer:tickets:scan',
  'organizer:tickets:checkin',
  'organizer:venues:read',
  'organizer:venues:write',
  'organizer:tiers:read',
  'organizer:tiers:write',
  'organizer:seats:read',
  'organizer:seats:write',
  'organizer:analytics:read',
  'organizer:staff:read',
  'organizer:staff:write',
  'organizer:staff:delete',
  'organizer:profile:read',
  'organizer:profile:write',
  'organizer:banking:read',
  'organizer:banking:write',
  'organizer:payments:read',
  'organizer:payments:write',
  'organizer:payments:refund',
];

// ── Default permissions per role ─────────────────────────────────────────────

export const ROLE_DEFAULTS: Record<string, Set<AdminPermission>> = {
  super_admin: new Set(PERMISSIONS),

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
    'media:read',
    'media:write',
    'media:delete',
    'scanner:verify',
    'scanner:checkin',
    'analytics:read',
    'audit:read',
    // Organizer management (subset)
    'organizer:applications:read',
    'organizer:events:read',
    'organizer:bookings:read',
    'organizer:analytics:read',
    'organizer:payments:read',
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
    'media:read',
    'media:write',
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
export function computePermissions(
  role: string,
  overrides: Record<string, boolean> | null | undefined
): Record<string, boolean> {
  const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS['event_manager'];
  const result: Record<string, boolean> = {};
  for (const p of PERMISSIONS) {
    const overrideVal = overrides?.[p];
    result[p] = overrideVal === true ? true : overrideVal === false ? false : defaults.has(p);
  }
  return result;
}

/** Check whether the admin has every permission in the required set. */
export function hasAllPermissions(
  perms: Record<string, boolean> | undefined,
  required: readonly string[]
): boolean {
  if (!perms) return false;
  return required.every((p) => !!perms[p]);
}

/** Check whether the admin has any permission in the set. */
export function hasAnyPermission(
  perms: Record<string, boolean> | undefined,
  required: readonly string[]
): boolean {
  if (!perms) return false;
  return required.some((p) => !!perms[p]);
}
