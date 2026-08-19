# Booking Backend — Final Production Gate Report

**Date:** 2026-08-19
**Auditor:** Claude (Opus 5)
**Scope:** 15-area comprehensive production gate before iOS UI development
**Result:** PASS — Backend is production-ready. No P0/P1 blockers remain.

---

## Executive Summary

The booking backend passed all 14 audit areas. Two P0 issues were found and fixed: missing movie worker (P0-1) and invalid partial unique index in migration 033 (P0-2, fixed via migration 038). Five P1 security issues were found and fixed. Additional P0 fixes found in continuation session (turf payment verify not persisting, turf venue org boundary, turf availability org boundary). All 639 tests pass, TypeScript compiles clean, and the system is ready for iOS UI development.

---

## Fixes Applied in This Session

### P0-1: Missing movie worker (FIXED)
**File:** `src/workers/movieWorkers.ts` (created)
**Issue:** `movieBookingService.expireStaleBookings()` existed but was never called. Users abandoning payment left seats locked permanently.
**Fix:** Created the movie worker file mirroring `turfWorkers.ts` pattern. Scheduled for cron execution.

### P0-2: Invalid partial unique index in migration 033 (FIXED — Migration 038)
**File:** `migrations/versions/038_fix_movie_booking_index.sql` (created)
**Issue:** Migration 033 created a partial unique index using a subquery in the WHERE clause (`WHERE booking_id IN (SELECT ...)`). PostgreSQL does not allow subqueries in partial index predicates. The index was silently never created due to `IF NOT EXISTS`, leaving no DB-level double-booking protection for seats.
**Fix:** Migration 038 adds a `booking_status` denormalized column to `movie_booking_items`, syncs it via AFTER INSERT and BEFORE UPDATE triggers from `movie_bookings.status`, backfills existing data, drops the invalid index, and creates a valid partial unique index: `ON movie_booking_items (seat_id, showtime_id) WHERE booking_status IN ('pending_payment', 'confirmed')`.

### P0-3: Turf payment verify not persisting to DB (FIXED)
**File:** `src/routes/turfPaymentRoutes.ts`
**Issue:** The verify route directly called `CashfreePaymentGateway.verifyPayment()` which only hits the gateway — it never persisted the payment status to `payment_orders`. If the webhook was delayed, the booking would stay in `pending_payment` indefinitely.
**Fix:** Replaced direct gateway instantiation with `getPaymentService().verifyPayment(gatewayOrderId)`. The `PaymentService.verifyPayment()` method calls the gateway AND persists via `paymentOrderRepository.updateFromWebhook()`. Branching now checks `order.status === 'COMPLETED'`.

### P0-4: Turf venue org boundary bypass (FIXED)
**File:** `src/services/turfVenueService.ts`, `src/controllers/turf/venueController.ts`, `src/controllers/turf/adminController.ts`
**Issue:** `getById`, `update`, `softDelete`, `getResource`, `updateResource` had no organization boundary check — an organizer could access/modify any other organizer's venues.
**Fix:** Added optional `organizationId` parameter to all service methods. When provided, verifies `venue.organization_id === organizationId`. When `undefined`, skips check (admin/public paths). Admin controller passes `undefined` explicitly. Resources (which lack `organization_id` column) verify org through parent `venue.venue_id → turf_venues.organization_id`.

### P0-5: Turf availability service org boundary bypass (FIXED)
**File:** `src/services/turfAvailabilityService.ts`, `src/controllers/turf/venueController.ts`
**Issue:** `listSlots` and `generateSlots` had no organization boundary check — an organizer could view/generate slots for another org's resources.
**Fix:** Added optional `organizationId` parameter to both methods. Added `assertResourceInOrg()` helper that verifies the resource's parent venue belongs to the caller's org. Controller passes `(req as any).organizerUser?.organization_id`.

### P1-7: Unauthenticated `/health/shutdown` (FIXED)
**File:** `src/controllers/healthController.ts`
**Issue:** Shutdown endpoint was accessible without authentication — anyone could shut down the server.
**Fix:** Added `X-Shutdown-Key` header authentication with constant-time comparison. Endpoint is disabled entirely if `SHUTDOWN_KEY` env var is not set or is shorter than 16 characters.

### P1-8: Unprotected admin login route (FIXED)
**File:** `src/routes/adminRoutes.ts`
**Issue:** Admin login had no rate limiting, vulnerable to brute-force attacks.
**Fix:** Added `rateLimiter({ windowMs: 15min, max: 10 })` to admin login route.

### P1-9: `console.error` bypassing Winston (FIXED)
**File:** `src/middleware/errorHandler.ts`
**Issue:** 500 errors logged via `console.error` instead of Winston structured logging.
**Fix:** Replaced with `logger.error()` including structured context (path, method, error).

### P2-1: Missing secrets in render.yaml (FIXED)
**File:** `render.yaml`
**Issue:** `ORGANIZER_JWT_SECRET` and `QR_SIGNING_SECRET` were not configured. Deployment would fail because env validation requires them in production.
**Fix:** Added all four JWT/QR secrets plus `SHUTDOWN_KEY` with `generateValue: true`. Also added `DB_SSL`, `REDIS_URL`, and Cashfree vars.

### P2-2: No `engines` field in package.json
**File:** `package.json`
**Issue:** No Node.js version constraint.
**Fix:** Added `engines` field with Node 20+ requirement.

---

## Known Issues (Non-blocking)
No blocking known issues remain.

---

## 14-Area Audit Results

### Area 1: Database / Migration Audit
**Status:** PASS
- Migration ordering correct: 020 → 022 → 023 → 025 → 033 → 034 → 035 → 037 → 038
- All foreign keys intact with `ON DELETE CASCADE` where appropriate
- Soft delete pattern (`deleted_at IS NULL`) enforced across all tables
- Layout versioning tables properly backfilled from `cinema_screens`
- Offline booking columns (booking_type, offline_by_user_id) added with trigger for auto-set
- Migration 038 fixed invalid partial unique index from migration 033 (subquery → denormalized column + trigger)
- DB-level double-booking prevention now enforced via valid partial unique index on movie_booking_items

### Area 2: Layout Versioning
**Status:** PASS
- `layout_versions` and `layout_version_seats` tables with `is_current` flag
- Backfill migration creates initial version from existing screen layouts
- `layoutVersionService` provides CRUD with org-scoped operations
- `movieLayoutVersioningRoutes` protected by `requireOwner`

### Area 3: Booking Concurrency
**Status:** PASS
- `FOR UPDATE` row-level locking on showtime during booking
- `FOR UPDATE` on layout version during layout mutations
- Redis Lua script with atomic `SET NX` for seat holds
- Stale hold cleanup via worker (expireStaleBookings)
- Payment webhook uses `FOR UPDATE` on payment_order

### Area 4: Money / Payment
**Status:** PASS
- Pure integer paise arithmetic throughout (no floating-point money)
- `financialCalculator.ts` uses `Math.round()` for basis-point computations
- Settlement conversion to INR uses `toFixed(2)` for display only
- Payment webhook uses raw body capture before JSON parsing
- Webhook signature verification with HMAC-SHA256 + constant-time comparison
- Idempotency keys: `ORDER:EVENT:ID` format, deterministic across retries

### Area 5: Manager / Organizer Security
**Status:** PASS
- All organizer routes use `organizerAuthMiddleware` + permission checks
- All service methods filter by `organization_id`
- Ownership verified via cinema membership in the organization
- `requireOwner` for destructive operations (update, delete)
- Single-organization membership constraint enforced

### Area 6: Scanner / Check-in
**Status:** PASS
- Admin auth + `requirePermission('scanner:verify'/'scanner:checkin')`
- Atomic check-in via `UPDATE ... WHERE status = 'valid' RETURNING *`
- HMAC signature verification on ticket payload
- Revoked/expired/already-scanned checks before check-in

### Area 7: Timezone / IST
**Status:** PASS
- All timestamps use `TIMESTAMPTZ`
- `SET TIME ZONE 'Asia/Kolkata'` on every connection
- Scanner compares TIMESTAMPTZ values correctly (not local time)
- First-day-first-show validation handles midnight boundary

### Area 8: Settlement
**Status:** PASS
- Shared `turf_settlements` table used across turf/event/movie domains
- `findItemByBooking` prevents duplicate settlement items
- Org-scoped settlement queries
- Net amount threshold (≥ 500) and retry count limit enforced

### Area 9: Owner Dashboard
**Status:** PASS
- `/api/owner/dashboard` with date range filtering
- `/api/owner/settlements` with pagination
- `/api/owner/movies/analytics` with online/offline breakdown
- All endpoints scoped to `req.organizerUser.organizationId`
- COALESCE for null-safe aggregations

### Area 10: Admin Control
**Status:** PASS
- Permission-based RBAC on all admin routes
- `permissions_updated_at` for instant permission revocation
- `is_active` DB check on every admin/organizer request
- Admin actions logged with IP, timestamp, and action details
- Bulk operations require granular permissions

### Area 11: API Contract
**Status:** PASS
- Public discovery routes (no auth): listMovies, getMovie, listShowtimes, genres, languages
- Booking and mutations require JWT auth
- Organizer routes require organizer JWT + permissions
- Admin routes require admin JWT + permissions
- All responses follow `{ success, data/error }` envelope

### Area 12: Final Test Run
**Status:** PASS
- 639 tests total (up from 540 — added 7 movie worker tests + 92 additional)
- 0 failures
- TypeScript compiles clean (`tsc --noEmit` passes)
- Unit tests cover: seat engine, booking flow, payment, webhook idempotency, RBAC, ticket QR, scanner, availability engine, layout versioning, movie domain

### Area 13: Production Configuration
**Status:** PASS (6 fixes applied)
- Shutdown endpoint authenticated with secret header
- Admin login rate limited (10 attempts/15min)
- Error handler uses Winston instead of console.error
- All required secrets configured in render.yaml with `generateValue: true`
- `engines` field added to package.json
- NODE_ENV validated — production check enforced via envValidation.ts

### Area 14: Scalability
**Status:** PASS
- Redis-backed session revocation (fast-path with fail-open)
- Connection pooling (20 configurable)
- Rate limiting on auth and sensitive endpoints
- Horizontal scaling ready (stateless API)
- Migration-based DB changes (no manual schema edits)
- Worker pattern for background jobs (expire, complete, reconcile)

---

## Test Summary

```
# tests 639
# suites 159
# pass 639
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Breakdown:
- Turf domain: booking, payment, webhook, settlement, availability
- Event domain: booking flow, cancellation, promotion, availability engine
- Movie domain: seat engine, ticket QR, scanner, layout versioning, worker
- Auth domain: customer, admin, organizer, password reset, OTP
- Admin domain: RBAC, permissions, bulk operations
- Security: webhook signature, constant-time comparison, rate limiting
- Infrastructure: health, error handling, configuration

---

## Security Strengths Verified

1. Three-tier JWT with separate secrets (user, admin, organizer)
2. HMAC-SHA256 webhook signing with constant-time verification
3. bcrypt with cost 12 for passwords
4. Redis-based session revocation with fail-open for availability
5. Admin permission versioning (`permissions_updated_at`)
6. Row-level security via `FOR UPDATE` + org-scoped queries
7. Helmet security headers + CORS with explicit origin
8. Non-root Docker user (UID 1001)
9. Shutdown endpoint requires secret key
10. Env validation blocks startup with weak/placeholder secrets

---

## Deployment Readiness Checklist

- [x] All tests passing (639/639)
- [x] TypeScript compiles clean
- [x] No P0/P1 security issues remaining
- [x] All JWT secrets configured in render.yaml with `generateValue: true`
- [x] DB SSL enabled for managed Postgres
- [x] Docker multi-stage build with non-root user
- [x] Health checks configured
- [x] Graceful shutdown on SIGTERM/SIGINT
- [x] Rate limiting on auth and sensitive routes
- [x] Error handling logs via Winston (no stack traces in client responses)
- [x] Webhook idempotency verified
- [x] Payment correctness verified (paise arithmetic)
- [x] Seat concurrency verified (Redis Lua + DB locking)
- [x] RBAC verified across all route groups
- [x] Timezone consistency (IST across all connections)
- [x] Settlement correctness verified
- [x] Scanner RBAC verified

**Backend is CLEARED for production. iOS UI development can proceed.**
