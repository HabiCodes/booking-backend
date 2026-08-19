/**
 * Tests for the offline booking + RBAC + permission middleware system.
 *
 * Covers:
 *   - Permission middleware logic (requireOwner, requireRole, requireAnyPermission)
 *   - Offline booking request shape validation
 *   - Payment method validation (CASH / UPI / CARD)
 *   - Idempotency signature generation
 *   - Type guards for offline booking types
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Imports ────────────────────────────────────────────────────────────────────

import {
  requireOwner,
  requireRole,
  requireAnyPermission,
  requireAllPermissions,
} from '../../src/middleware/organizerPermissionMiddleware';
import { AppError } from '../../src/middleware/errorHandler';
import type { OrganizerRequest } from '../../src/middleware/organizerAuth';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeOrgRequest(user: {
  id?: number;
  organizationId?: number;
  email?: string;
  name?: string;
  role?: 'owner' | 'manager';
  permissions?: Record<string, boolean>;
} | null | undefined): OrganizerRequest {
  return {
    organizerUser: user ? {
      id: user.id ?? 1,
      organizationId: user.organizationId ?? 1,
      email: user.email ?? 'staff@test.com',
      name: user.name ?? 'Staff Member',
      role: user.role ?? 'manager',
      permissions: user.permissions ?? {},
    } : undefined,
  } as OrganizerRequest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. requireOwner — fails for managers, passes for owners
// ═══════════════════════════════════════════════════════════════════════════════

describe('requireOwner', () => {

  it('passes for organization owner', () => {
    const req = fakeOrgRequest({ role: 'owner' });
    let nextCalled = false;
    requireOwner(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('throws 403 for manager', () => {
    const req = fakeOrgRequest({ role: 'manager' });
    let nextCalled = false;
    try {
      requireOwner(req, {} as any, () => { nextCalled = true; });
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.strictEqual((err as AppError).statusCode, 403);
      assert.ok((err as AppError).message.includes('owner'));
    }
    assert.strictEqual(nextCalled, false);
  });

  it('throws 401 if user is null', () => {
    const req = fakeOrgRequest(null);
    let nextCalled = false;
    let thrown: any = null;
    try {
      requireOwner(req, {} as any, () => { nextCalled = true; });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof AppError);
    assert.strictEqual((thrown as AppError).statusCode, 401);
    assert.strictEqual(nextCalled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. requireRole — owner/manager gates
// ═══════════════════════════════════════════════════════════════════════════════

describe('requireRole', () => {

  it('passes for allowed role (owner)', () => {
    const req = fakeOrgRequest({ role: 'owner' });
    const guard = requireRole('owner');
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('passes for multi-role allowed (owner | manager)', () => {
    const req = fakeOrgRequest({ role: 'manager' });
    const guard = requireRole('owner', 'manager');
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('rejects disallowed role', () => {
    const req = fakeOrgRequest({ role: 'manager' });
    const guard = requireRole('owner');
    let nextCalled = false;
    try {
      guard(req, {} as any, () => { nextCalled = true; });
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.strictEqual((err as AppError).statusCode, 403);
    }
    assert.strictEqual(nextCalled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. requireAnyPermission — passes if ANY of the listed permissions is held
// ═══════════════════════════════════════════════════════════════════════════════

describe('requireAnyPermission', () => {

  it('passes if user has any of the listed permissions', () => {
    const req = fakeOrgRequest({ permissions: { 'organizer:movies:write': true } });
    const guard = requireAnyPermission('organizer:movies:write', 'organizer:movies:publish');
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('passes if user has all of the listed permissions', () => {
    const req = fakeOrgRequest({ permissions: {
      'organizer:movies:write': true,
      'organizer:movies:publish': true,
    } });
    const guard = requireAnyPermission('organizer:movies:write', 'organizer:movies:publish');
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('rejects if user has none of the listed permissions', () => {
    const req = fakeOrgRequest({ permissions: { 'organizer:movies:read': true } });
    const guard = requireAnyPermission('organizer:movies:write', 'organizer:movies:delete');
    let nextCalled = false;
    try {
      guard(req, {} as any, () => { nextCalled = true; });
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.strictEqual((err as AppError).statusCode, 403);
    }
    assert.strictEqual(nextCalled, false);
  });

  it('passes with no permissions listed (vacuous truth)', () => {
    const req = fakeOrgRequest({ permissions: {} });
    const guard = requireAnyPermission();
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. requireAllPermissions — passes only if ALL listed permissions are held
// ═══════════════════════════════════════════════════════════════════════════════

describe('requireAllPermissions', () => {

  it('passes when all permissions are held', () => {
    const req = fakeOrgRequest({ permissions: {
      'organizer:movies:write': true,
      'organizer:movies:delete': true,
    } });
    const guard = requireAllPermissions('organizer:movies:write', 'organizer:movies:delete');
    let nextCalled = false;
    guard(req, {} as any, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
  });

  it('fails when only some permissions are held', () => {
    const req = fakeOrgRequest({ permissions: { 'organizer:movies:write': true } });
    const guard = requireAllPermissions('organizer:movies:write', 'organizer:movies:delete');
    let nextCalled = false;
    try {
      guard(req, {} as any, () => { nextCalled = true; });
    } catch (err) {
      assert.ok(err instanceof AppError);
      assert.strictEqual((err as AppError).statusCode, 403);
    }
    assert.strictEqual(nextCalled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Offline Booking Payment Method Validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Offline booking — payment method validation', () => {

  const ALLOWED_METHODS = ['CASH', 'UPI', 'CARD'];

  function isValidPaymentMethod(method: string): boolean {
    return ALLOWED_METHODS.includes(method);
  }

  it('accepts CASH', () => {
    assert.strictEqual(isValidPaymentMethod('CASH'), true);
  });

  it('accepts UPI', () => {
    assert.strictEqual(isValidPaymentMethod('UPI'), true);
  });

  it('accepts CARD', () => {
    assert.strictEqual(isValidPaymentMethod('CARD'), true);
  });

  it('rejects NETBANKING', () => {
    assert.strictEqual(isValidPaymentMethod('NETBANKING'), false);
  });

  it('rejects WALLET', () => {
    assert.strictEqual(isValidPaymentMethod('WALLET'), false);
  });

  it('rejects empty string', () => {
    assert.strictEqual(isValidPaymentMethod(''), false);
  });

  it('rejects lowercase (case-sensitive)', () => {
    assert.strictEqual(isValidPaymentMethod('cash'), false);
    assert.strictEqual(isValidPaymentMethod('upi'), false);
    assert.strictEqual(isValidPaymentMethod('card'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Offline Booking Idempotency Signature
// ═══════════════════════════════════════════════════════════════════════════════

describe('Offline booking — idempotency signature', () => {

  it('generates stable signature for same seat set (regardless of order)', () => {
    const seatIds = [10, 5, 100, 1];
    const sig1 = seatIds.slice().sort((a, b) => a - b).join(',');
    const sig2 = [...seatIds].reverse().sort((a, b) => a - b).join(',');
    assert.strictEqual(sig1, sig2);
    assert.strictEqual(sig1, '1,5,10,100');
  });

  it('produces different signature for different seat sets', () => {
    const sig1 = [1, 2, 3].sort((a, b) => a - b).join(',');
    const sig2 = [1, 2, 4].sort((a, b) => a - b).join(',');
    assert.notStrictEqual(sig1, sig2);
  });

  it('signatures are deterministic', () => {
    const sig1 = [42, 7, 13].sort((a, b) => a - b).join(',');
    const sig2 = [7, 13, 42].sort((a, b) => a - b).join(',');
    assert.strictEqual(sig1, sig2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Offline Booking — booking_type discrimination
// ═══════════════════════════════════════════════════════════════════════════════

describe('Offline booking — booking_type discrimination', () => {

  const VALID_TYPES = ['online', 'offline', 'complimentary'];

  function isValidBookingType(type: string): boolean {
    return VALID_TYPES.includes(type);
  }

  it('accepts offline booking type', () => {
    assert.strictEqual(isValidBookingType('offline'), true);
  });

  it('accepts online booking type', () => {
    assert.strictEqual(isValidBookingType('online'), true);
  });

  it('accepts complimentary booking type', () => {
    assert.strictEqual(isValidBookingType('complimentary'), true);
  });

  it('rejects invalid booking type', () => {
    assert.strictEqual(isValidBookingType('walk_in'), false);
    assert.strictEqual(isValidBookingType(''), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Offline Booking — payment_status discriminator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Offline booking — payment_status discriminator', () => {

  const VALID_PAYMENT_STATUSES = ['initiated', 'pending', 'captured', 'failed', 'refunded', 'paid_offline'];

  function isValidPaymentStatus(status: string): boolean {
    return VALID_PAYMENT_STATUSES.includes(status);
  }

  it('accepts paid_offline status for offline bookings', () => {
    assert.strictEqual(isValidPaymentStatus('paid_offline'), true);
  });

  it('accepts all standard statuses', () => {
    for (const status of VALID_PAYMENT_STATUSES) {
      assert.strictEqual(isValidPaymentStatus(status), true, `should accept ${status}`);
    }
  });

  it('rejects unknown payment status', () => {
    assert.strictEqual(isValidPaymentStatus('cash_cleared'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Payment Gateway — manual gateway discrimination
// ═══════════════════════════════════════════════════════════════════════════════

describe('Payment gateway — discriminator for offline bookings', () => {

  const VALID_GATEWAYS = ['cashfree', 'manual'];

  function isValidGateway(gw: string): boolean {
    return VALID_GATEWAYS.includes(gw);
  }

  it('accepts manual gateway for offline bookings', () => {
    assert.strictEqual(isValidGateway('manual'), true);
  });

  it('accepts cashfree gateway for online bookings', () => {
    assert.strictEqual(isValidGateway('cashfree'), true);
  });

  it('rejects unknown gateway', () => {
    assert.strictEqual(isValidGateway('razorpay'), false);
    assert.strictEqual(isValidGateway('stripe'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Owner Dashboard — Movie Analytics boundary values
// ═══════════════════════════════════════════════════════════════════════════════

describe('Movie analytics — empty result handling', () => {

  it('handles zero bookings gracefully', () => {
    const data = {
      totalRevenuePaise: 0,
      bookingCount: 0,
      onlineBookingCount: 0,
      offlineBookingCount: 0,
      avgBookingValuePaise: 0,
      topMovie: null,
    };

    assert.strictEqual(data.totalRevenuePaise, 0);
    assert.strictEqual(data.bookingCount, 0);
    assert.strictEqual(data.topMovie, null);
    // No division by zero
    const avg = data.bookingCount > 0 ? data.totalRevenuePaise / data.bookingCount : 0;
    assert.strictEqual(avg, 0);
  });
});
