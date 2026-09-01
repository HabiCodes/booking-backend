# Phase 4 — Manager Operations Production Audit Report
**Booking Backend v3 | Date: 2026-09-01**

---

## Executive Summary

This audit covers the complete manager architecture across all three booking domains (Events, Movies, Turf). **10 findings were identified: 2 CRITICAL, 2 HIGH, 3 MEDIUM, 3 LOW.** Of these, findings 1 and 2 are confirmed production-breaking bugs; finding 3 is a security vulnerability; finding 4 is a design gap that could lead to permission confusion.

**Recommendation: CONDITIONAL GO** — The core booking architecture is sound (atomic operations, HMAC-signed tickets, proper domain isolation). However, the critical SQL bug and broken offline booking flow must be fixed before deployment. The security gap in turf organizer routes should be addressed in the same sprint.

---

## Audit Scope

| Domain | Manager Auth | Manager Routes | Offline Booking | Online Booking | Scan/QR | Analytics |
|--------|-------------|---------------|-----------------|----------------|---------|-----------|
| Events | ✅ organizer JWT | ✅ Permission guards | ❌ Not implemented | ✅ | ✅ (via admin) | ✅ (owner only) |
| Movies | ✅ organizer JWT | ✅ Permission guards | ✅ | ✅ | ✅ (via admin) | ✅ (owner only) |
| Turf | ✅ organizer JWT | ❌ CRITICAL bugs | ❌ Broken | ✅ | ✅ (via admin) | ✅ (owner only) |

---

## Detailed Findings

---

### FINDING 1 — CRITICAL: Non-existent column in SQL queries
**File:** `src/routes/turfManagerRoutes.ts`
**Lines:** 40, 113, 204, 236, 294, 346
**Type:** BUG

**Issue:** All 6 queries use `WHERE user_id = $1` against the `organizer_users` table, but this column does not exist. The table was created in migration 016 with `id` (BIGSERIAL PK) as the primary key. There is no `user_id` column.

**Current (broken) code:**
```typescript
// Line 40 (and identical at lines 113, 204, 236, 294, 346)
const orgUser = await getPool().query(
  'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
  [userId, orgId]
);
```

**Impact:** Every turf manager endpoint throws a PostgreSQL error (`column "user_id" does not exist`) with status 500. This means:
- Offline booking is completely broken
- QR validation is completely broken
- Booking cancellation is completely broken
- Attendance reports are completely broken
- Daily reports are completely broken
- Entry logs are completely broken

**Fix:** Replace `user_id` with `id`:
```typescript
const orgUser = await getPool().query(
  'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
  [userId, orgId]
);
```

---

### FINDING 2 — CRITICAL: Turf offline booking is broken end-to-end
**File:** `src/routes/turfManagerRoutes.ts` (lines 73-83)
**Type:** BUG

**Issue:** The offline booking flow calls `createBooking()` then immediately calls `confirmBooking()`. However:
- `createBooking()` creates a `turf_bookings` row with status `pending_payment` but does NOT create a `payment_orders` row
- `confirmBooking()` checks for a `payment_orders` row and requires `status === 'COMPLETED'` — this will throw `'Payment not initiated for this booking'`

**Current (broken) code:**
```typescript
// Create offline booking
const booking = await turfBookingService.createBooking(customerId, {
  availability_unit_id: Number(availabilityUnitId),
  quantity,
  booking_type: 'offline',
}, { actorId: userId, actorType: 'manager' });

// Auto-confirm offline bookings — THIS FAILS
const confirmed = await turfBookingService.confirmBooking(booking.booking.id, {
  actorId: userId,
  actorType: 'manager',
});
```

**Reference (movie offline booking works correctly):**
```typescript
// movieOfflineBookingService.ts — creates payment_orders and marks COMPLETED
const orderId = `OFMOV_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
await paymentOrderRepository.create({ ...orderId, booking_id: booking.id, ... });
await paymentOrderRepository.updateFromWebhook(orderId, {
  status: 'COMPLETED',
  payment_method: input.paymentMethod,
  provider_payment_id: input.paymentReference || `manual_${input.paymentMethod.toLowerCase()}`,
});
```

**Impact:** Any walk-in customer booking at a turf managed by this system will fail with a 409 error. No offline bookings can succeed.

**Fix:** Add an `offline` mode to `turfBookingService.confirmBooking()` that skips the payment_orders check, OR create the payment_orders row and mark it COMPLETED inline (matching the movie pattern).

---

### FINDING 3 — HIGH: Turf organizer routes have zero permission guards
**File:** `src/routes/turfOrganizerRoutes.ts`
**Type:** SECURITY GAP

**Issue:** The entire turf organizer router (15 endpoints) uses only `organizerAuthMiddleware`. Any authenticated organizer user — including managers — can:
- Create/update/delete venues
- Create/update resources
- Generate time slots
- Create coupons
- View financial settlements

**Comparison with movie manager routes (properly guarded):**
```typescript
// movieManagerRoutes.ts — proper permission checks
organizerMovieRouter.get('/movies', requireOrganizerPermission('organizer:movies:read'), listOrgMovies);
organizerMovieRouter.post('/movies', requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'), createOrgMovie);
organizerMovieRouter.delete('/movies/:id', requireOwner, deleteOrgMovie);
organizerMovieRouter.put('/price-caps/:id', requireOwner, updateOrgPriceCap);
```

**Comparison with turf organizer routes (NO guards):**
```typescript
// turfOrganizerRoutes.ts — no permission checks at all
router.use(organizerAuthMiddleware);  // ← only this
router.post('/venues', (req, res, next) => createVenue(req, res, next));  // ← any manager can create venues
router.delete('/venues/:venueId', (req, res, next) => deleteVenue(req, res, next));  // ← any manager can delete venues
router.post('/coupons', (req, res, next) => createCoupon(req, res, next));  // ← any manager can create coupons
```

**Impact:** A turf manager can delete venues, create unlimited discount coupons, and access financial settlement data. This is a significant security vulnerability.

**Fix:** Add permission middleware to all turf organizer routes. Define turf-specific permissions:
- `organizer:venues:read`, `organizer:venues:write`, `organizer:venues:delete`
- `organizer:resources:read`, `organizer:resources:write`
- `organizer:slots:read`, `organizer:slots:write`
- `organizer:coupons:read`, `organizer:coupons:write`
- `organizer:settlements:read`

---

### FINDING 4 — HIGH: No turf_manager or movie_manager role in RBAC system
**File:** `src/rbac/permissions.ts`
**Type:** DESIGN GAP

**Issue:** The `ROLE_DEFAULTS` object defines permissions for only 4 roles:
```typescript
const ROLE_DEFAULTS: Record<string, Record<string, boolean>> = {
  super_admin: { '*': true },
  admin: { 'events:read': true, 'events:write': true, 'movies:read': true, ... },
  event_manager: { 'events:read': true, 'events:write': true, 'scanner:verify': true, 'scanner:checkin': true },
  ticket_scanner: { 'scanner:verify': true, 'scanner:checkin': true },
};
```

When a manager is created with `role = 'turf_manager'` or `role = 'movie_manager'`, `computePermissions()` falls back to the `event_manager` defaults. This means:
- Turf managers get event permissions (which is harmless but confusing)
- Movie managers get event permissions (which is harmless but confusing)
- Neither role has domain-specific defaults

**Impact:** All turf_manager and movie_manager users get event_manager permission defaults. This doesn't cause a functional bug (the permission strings don't include turf/movie operations), but it means the role system doesn't enforce domain isolation. The entire authorization model relies on manual permission assignment, which is error-prone.

**Fix:** Add `turf_manager` and `movie_manager` to `ROLE_DEFAULTS` with domain-appropriate defaults.

---

### FINDING 5 — MEDIUM: turfVenueController uses wrong property name
**File:** `src/controllers/turf/venueController.ts` (line 13)
**Type:** BUG (Potential)

**Issue:** The controller uses `(req as any).organizerUser?.organization_id` (snake_case), but `organizerAuthMiddleware` sets `organizationId` (camelCase) on `req.organizerUser`.

**Comparison:**
```typescript
// venueController.ts — WRONG (snake_case)
const orgId = (req as any).organizerUser?.organization_id;  // undefined!

// organizerController.ts — CORRECT (camelCase)
const orgId = (req as any).organizerUser?.organizationId;   // works
```

**Why it may not be noticed:** JavaScript returns `undefined` for missing object keys without throwing. The `orgId` is passed to service methods that do their own org verification via the venue's `organization_id` DB column, so the endpoint doesn't crash — it just loses its org-scoping shortcut.

**Impact:** Every venue/resource/slot endpoint in turfOrganizerRoutes will receive `undefined` as `orgId`. The service methods will still verify ownership via the venue record, but list operations (which rely on `orgId` to filter) may return results across all organizations instead of just the requester's.

**Fix:** Change `organization_id` to `organizationId` in all 11 controller methods.

---

### FINDING 6 — MEDIUM: ownerManagerRoutes PATCH endpoint lacks owner verification
**File:** `src/routes/ownerManagerRoutes.ts` (line 119)
**Type:** SECURITY GAP

**Issue:** The `PATCH /managers/:id` endpoint checks for `organizerAuthMiddleware` but does not verify the requester is an owner. Any authenticated organizer (including other managers) can modify another manager's permissions.

```typescript
// Line 119 — no requireOwner or requireRole check
router.patch('/:id', async (req, res, next) => { ... });
```

**Contrast with:** The `POST /managers` (create) endpoint at line 92 properly checks `requireOwner`.

**Impact:** A manager could elevate their own permissions or modify another manager's access. In a multi-owner organization, this creates privilege escalation risk.

**Fix:** Add `requireOwner` to the PATCH route.

---

### FINDING 7 — MEDIUM: No token revocation on manager deactivation
**File:** `src/middleware/organizerAuth.ts` + `src/services/organizerAuthService.ts`
**Type:** SECURITY GAP

**Issue:** When a manager is deactivated (`is_active = false`), the middleware correctly rejects requests on the NEXT request (it checks `is_active` on every request). However:
- Any JWTs already issued remain cryptographically valid until expiry (8h access, 30d refresh)
- Refresh tokens are NOT revoked on deactivation
- The manager can continue operating until their token expires (up to 30 days with refresh)

**Impact:** A deactivated manager retains access for up to 30 days. If the deactivation is for cause (security incident, termination), this is a significant gap.

**Fix:** On manager deactivation:
1. Revoke all active refresh tokens for the user
2. Store a `token_version` counter — increment on deactivation, reject all tokens with old version
3. Or use a token blacklist for the deactivated user's JTI claims

---

### FINDING 8 — LOW: No event manager offline/counter booking
**File:** `src/services/bookingService.ts` — No offline booking support
**Type:** MISSING FEATURE

**Issue:** Movie domain has `movieOfflineBookingService.ts` for walk-in/counter bookings. Turf domain has `turfManagerRoutes.ts` for offline bookings (though broken). The event domain has NO offline booking mechanism at all.

**Impact:** Event organizers cannot sell tickets at the venue entrance. All event tickets must be purchased online. This may be intentional (events typically have pre-booked audiences), but it's an inconsistency.

**Fix:** Either implement event offline booking, or document it as intentional with a comment.

---

### FINDING 9 — LOW: Manager scan endpoints require admin credentials
**File:** `src/routes/turfScanRoutes.ts`, `src/routes/movieScanRoutes.ts`, `src/routes/scanRoutes.ts`
**Type:** ARCHITECTURAL INCONSISTENCY

**Issue:** All three scan endpoints use `adminAuthMiddleware` + `requireScannerAuthorization`. Manager scan happens through the admin JWT system. This means:
- Managers need admin-level credentials to scan (or the admin system must issue scanner tokens)
- There's no dedicated "manager scan" flow

**Current flow for manager scanning:**
1. Manager logs in via organizer JWT (different system)
2. To scan a ticket, the manager must use an admin/scanner credential
3. These are separate credentials, separate logins, separate token systems

**Impact:** UX friction — managers need two login systems. Operational risk — scanner credentials may be shared or stored insecurely.

**Fix (low priority):** Create organizer-level scan endpoints (`organizerScanRoutes.ts`) that accept organizer JWTs and check `organizer:scanner:verify` / `organizer:scanner:checkin` permissions.

---

### FINDING 10 — LOW: movieOfflineBookingService bypasses standard booking flow
**File:** `src/services/movieOfflineBookingService.ts`
**Type:** DESIGN INCONSISTENCY

**Issue:** Movie offline booking bypasses the standard `movieBookingService` entirely. It creates bookings, payment orders, and tickets directly without using the shared booking infrastructure. This means:
- The standard movie booking flow uses: `createBooking` → `payment_orders` → `confirmBooking` → tickets
- The offline flow uses: direct INSERT → payment_orders → COMPLETED → tickets
- No shared code path for validation, pricing, or coupon logic

**Impact:** Bug fixes to the booking flow (pricing, validation, coupons) may not apply to offline bookings. Code duplication creates maintenance risk.

**Fix:** Refactor offline booking to reuse the standard booking service's validation and pricing logic.

---

## Cross-Cutting Concerns

### Rate Limiting
- `organizerWriteRateLimiter`: 30 req/min per org — applied to event write routes but NOT to turf write routes
- No rate limiting on turf venue/resource/slot creation
- No rate limiting on booking creation beyond `bookingRateLimiter` (15/min globally)

### Multi-Instance Safety
- All database operations use proper `FOR UPDATE` row locking or atomic `UPDATE ... WHERE status=X RETURNING *` patterns
- Redis Lua scripts used for movie seat holds (atomic)
- No shared in-memory state (rate limiter uses per-org keys)
- No known race conditions in booking flows

### Analytics
- `ownerDashboardRoutes` correctly uses `requireOwner` — only owners see analytics
- Manager-level analytics: Daily report, attendance, and entry logs exist for turf; no equivalent for events/movies

### Payment
- Online bookings: payment_orders table with Cashfree integration — consistent across all domains
- Offline bookings: Movie creates payment_orders + COMPLETED inline; Turf broken (no payment_orders)
- No offline payment path for events

### Mobile/App Contract
- Three separate login endpoints (no unified manager login)
- Role detection: JWT payload contains `role` field — app renders UI based on role
- Turf manager QR: HMAC-SHA256 signed, stored in `metadata.signature`
- Movie manager QR: HMAC-SHA256 signed, stored in `qr_data.signature`
- Event tickets: HMAC-SHA256 signed via `tickets.qr_data`

---

## Severity Summary

| Severity | Count | Findings |
|----------|-------|----------|
| CRITICAL | 2 | Finding 1 (SQL bug), Finding 2 (offline booking broken) |
| HIGH | 2 | Finding 3 (no permission guards), Finding 4 (no manager roles in RBAC) |
| MEDIUM | 3 | Finding 5 (wrong property), Finding 6 (PATCH owner check), Finding 7 (no token revocation) |
| LOW | 3 | Finding 8 (no event offline booking), Finding 9 (admin scan), Finding 10 (offline bypass) |

---

## Recommendation

**CONDITIONAL GO** — Fix Findings 1, 2, and 5 (bugs) + Finding 3 (security gap) before deployment. These are production-blocking. Findings 6, 7 can be addressed in a follow-up sprint. Findings 8, 9, 10 are enhancement items.
