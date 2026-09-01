# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Dev server (hot reload via ts-node-dev)
npm run dev

# Production build → dist/server.js
npm run build && npm start

# Seed admin user (uses ADMIN_EMAIL / ADMIN_PASSWORD from .env)
npm run seed:admin

# Run all migrations against the DB
npm run db:migrate

# Tests (compile TS → .test-build/ first per tsconfig.test.json, then Node runs the JS)
npm test                          # all
npm run test:unit                 # unit tests only
npm run test:integration          # integration + e2e

# Run a single test file
npx node --test .test-build/tests/unit/<file>.test.js
```

No linter is configured.

## Architecture

### Three domains, one backend

Event bookings, movie bookings, and turf (sports-field) bookings each have their own controllers, services, repositories, and workers under `src/`. They share a single Express app, PostgreSQL database, and Redis instance.

### Request flow

`src/server.ts` mounts routes under `/api/v1/` via a top-level `apiV1` router. Legacy `/api/*` returns a 301 redirect with a deprecation header. Health endpoints (`/health/live`, `/health/ready`, `/health/shutdown`) are unversioned.

Each domain follows: **Route → Middleware → Controller → Service → Repository → PostgreSQL**. Repositories are plain classes with `async` query methods; there is no ORM. Transactions use the `withTransaction` helper (explicit BEGIN/COMMIT/ROLLBACK).

### Route map

```
apiV1.use('/auth', authRateLimiter, authRoutes)
apiV1.use('/events', eventRoutes)
apiV1.use('/bookings', bookingRoutes)
apiV1.use('/turf/admin', turfAdminRoutes)
apiV1.use('/turf/organizer', turfOrganizerRoutes)
apiV1.use('/turf/manager', turfManagerRoutes)
apiV1.use('/scan', scanRoutes)               // event scan
apiV1.use('/scan/movies', movieScanRoutes)
apiV1.use('/scan/turf', turfScanRoutes)
apiV1.use('/admin', adminRoutes)
apiV1.use('/owner', ownerDashboardRoutes)
apiV1.use('/owner', ownerManagerRoutes)
apiV1.use('/organizer/auth', organizerAuthRoutes)
apiV1.use('/organizer/events', organizerEventRoutes)
apiV1.use('/organizer/organizations', organizerOrganizationRoutes)
apiV1.use('/organizer/movies', organizerMovieRouter)
```

### Authentication layers

Three separate JWT secrets and middleware files for three identity spaces:

| Middleware file | Secret env | Token `typ` | Used by |
|---|---|---|---|
| `middleware/auth.ts` | `JWT_SECRET` | `access` | `/api/v1/auth`, customer booking flows |
| `middleware/adminAuth.ts` | `ADMIN_JWT_SECRET` | `admin_access` | `/api/v1/admin/*`, event/movie/turf scan endpoints |
| `middleware/organizerAuth.ts` | `ORGANIZER_JWT_SECRET` | `organizer_access` | `/api/v1/organizer/*`, turf/movie manager routes |

All middleware checks the DB for `is_active` on every request. Organizer middleware additionally checks Redis for server-side session revocation (key: `org_revoked:{userId}`, TTL = JWT expiry). Admin middleware supports a `permissions_updated_at` versioning check so RBAC changes take effect before JWT expiry.

**Organizer auth specifics:**
- Account lockout after 5 consecutive failed logins, auto-reset on success
- Refresh token rotation with atomic find-and-consume; token reuse triggers full session revocation
- Logout revokes refresh tokens, DB sessions, AND sets the Redis revocation flag
- JWT payload includes `{id, sub, organization_id, name, role, permissions, typ:'organizer_access'}`

### QR ticket signing and verification

Tickets are signed with HMAC-SHA256 using `QR_SIGNING_SECRET`. The canonical payload is:

```
${ticket_uuid}|${entityId}|${startAt}
```

Where `startAt` is the ISO datetime of the event/showtime/slot start. Verification uses constant-time comparison to prevent timing attacks.

- `src/utils/qrCode.ts` — canonical signing/verification helpers
- `src/services/universalTicketService.ts` — domain-aware wrapper (`sign`/`verify` + `ticketCode`)
- Domain prefixes: `evt_` (event), `trf_` (turf), `mov_` (movie), `mgm_` (manager offline)

**Critical mismatch:** `movieOfflineBookingService.ts` signs offline tickets with the real `show_datetime` as `startAt`, but `movieScanService.ts` verifies with an empty string `''` for `startAt`. This causes offline-issued movie tickets to fail gate-scanner verification.

### Scan service pattern

All three scan endpoints (`/scan`, `/scan/movies`, `/scan/turf`) follow the same middleware chain:

```
adminAuthMiddleware → requireScannerAuthorization → requirePermission('scanner:verify'|'scanner:checkin')
```

`requireScannerAuthorization` (`src/middleware/scannerAuth.ts`) blocks `super_admin` accounts and requires an `organizationId` — platform-level admins without org context cannot scan tickets.

Each scan service: **verify signature → update ticket status to checked_in** using conditional UPDATE (`WHERE status = 'issued'`) to prevent double-scanning. No DB-level constraint enforces this — protection is application-only.

### RBAC

`src/rbac/permissions.ts` defines ~70 granular permissions in colon-separated format (e.g. `organizer:movies:read`). Permissions are stored as a JSONB `Record<string, boolean>` on admin/organizer rows and injected into the JWT payload. Route-level guards (`requireOrganizerPermission`, `requireOwner`, etc.) check `req.organizerUser.permissions` or `req.organizerUser.role`.

**`computePermissions` role fallback bug:** `ROLE_DEFAULTS` is keyed by `'event_manager'`, `'movie_manager'`, `'turf_manager'`, but the DB `organizer_users.role` column only stores `'owner'` or `'manager'`. Every organizer user falls through to `event_manager` defaults. Domain-specific permission sets (`movie_manager`, `turf_manager`) are documentation only — actual access control is entirely via per-user JSONB overrides.

### Manager QR check-in (turf)

`turfBookingService.checkInBooking` (line 507) handles QR-based check-in. It validates QR status (issued/used/revoked) and QR-booking match, but does **not** validate that the scanning manager owns the booking. Any manager in the org can check in any booking via QR. This contrasts with `turfBookingService.checkIn` (line 464), which validates `booking.user_id === actor.actorId` for customer self check-in.

### Known security issues in existing code

These are real defects, not style preferences. Fix them or work around them deliberately.

- **Movie QR signature mismatch (CRITICAL):** `movieOfflineBookingService.ts` signs tickets with `(ticket_uuid, showtime_id, show_datetime)`, but `movieScanService.ts` verifies with `(ticket_uuid, showtime_id, '')` — empty `startAt`. Offline-issued movie tickets will fail gate-scanner verification. Fix the verifier to pass the real `show_datetime`.

- **`computePermissions` role fallback (HIGH):** `src/rbac/permissions.ts:103` — `ROLE_DEFAULTS` is keyed by `'event_manager'`, `'movie_manager'`, `'turf_manager'`, but the DB `organizer_users.role` column only stores `'owner'` or `'manager'`. Every organizer user falls through to `event_manager` defaults; domain-specific permissions only appear via per-user JSONB overrides. The named role sets are documentation, not enforcement.

- **Organizer org routes lack org boundary (CRITICAL):** `src/routes/organizerOrganizationRoutes.ts` does not verify the requesting user belongs to the target org. Any authenticated organizer can PATCH/GET any org by ID.

- **Invitation permission keys mismatch (HIGH):** `src/services/organizerInvitationService.ts:140-149` stores permissions with underscore-separated keys (`movies_read`) but the runtime catalog uses colon-separated keys (`organizer:movies:read`). Invited managers get zero effective permissions.

- **`assigned_venue_ids` not enforced (HIGH):** The field exists on `organizer_users` and is used in analytics, but no turf route handler checks it. A manager assigned to venue 5 can access venue 10 in the same org.

- **`analytics:read` permission typo (MEDIUM):** `src/routes/turfManagerRoutes.ts` daily-report endpoint requires `analytics:read` but the permission catalog has `organizer:analytics:read`. Turf managers are always denied.

- **Manager password reset doesn't revoke JWTs (MEDIUM):** `src/routes/ownerManagerRoutes.ts` reset-password endpoint does not call `revokeOrganizerSessionsRedis`. The manager's existing JWT remains valid until natural expiry.

- **Manager QR check-in bypasses ownership (LOW):** `turfBookingService.checkInBooking` (line 507) does not validate that the scanning manager owns the booking. Any manager in the org can check in any booking via QR. This may be intentional for staff convenience, but differs from the customer check-in path which enforces ownership.

### Rate limiting

Rate limiting is **in-memory** (not Redis-backed). The comment in `src/middleware/rateLimiter.ts` says "For production, swap for a Redis-backed implementation." Presets include `authRateLimiter` (20 req/15min) and `resendVerificationLimiter` (5 req/hour).

Note: `withWriteRate` is declared in both `src/routes/turfManagerRoutes.ts:31-32` and `src/routes/turfOrganizerRoutes.ts:54`, but is **only used** in `turfOrganizerRoutes.ts` via the spread pattern (`...withWriteRate(handler)`). It is declared but never applied in `turfManagerRoutes.ts`.

### Background workers

Three worker files (`src/workers/turfWorkers.ts`, `src/workers/movieWorkers.ts`, `src/workers/eventWorkers.ts`) handle stale-booking expiration, hold cleanup, and payment timeout. They run on a 5-minute interval, gated by a distributed Redis lock (`src/infrastructure/workerLock.ts`) so only one API instance executes them. An initial sweep also runs at boot.

### Turf availability engine

Turf uses a rolling 15-day availability window pre-generated into `turf_availability_units`. A scheduler (`src/services/turfAvailabilityScheduler.ts`, started at boot via distributed lock) keeps the window extended. Slots are locked via Redis during booking to prevent double-booking. `turfBookingService.confirmBooking` and `cancelBooking` use `SELECT ... FOR UPDATE`; `checkInBooking` does not (known inconsistency).

### Offline / counter booking

Movie and turf domains support offline/counter bookings:
- **Movie:** `src/services/movieOfflineBookingService.ts` — creates tickets signed with real `show_datetime`, uses `PricingEngine` for GST 18% + 2% platform fee, payment marked as `paid_offline`
- **Turf:** handled within `turfOrganizerRoutes.ts` and `turfManagerRoutes.ts` with similar offline payment flow
- **Event domain:** has no offline/counter booking service — event bookings are online-only

### Payment & settlement

Payment processing goes through a provider-adapter layer (`src/services/paymentGateway.ts`, `src/services/cashfreeService.ts`). Settlements use a double-entry ledger. Turf and movie domains each have their own settlement repositories. Offline payments create payment orders with status `paid_offline` and mark them COMPLETED immediately.

### Socket.IO

Real-time booking-count broadcasts use Socket.IO with a Redis adapter for cross-instance pub/sub. Clients join the `live` room on connect.

### Database

- 51+ numbered SQL migrations in `migrations/versions/` (000–051), run idempotently on boot via `src/db/migrations.ts`.
- A PostgreSQL advisory lock prevents concurrent migration runs across instances.
- Timezone is forced to `Asia/Kolkata` on every connection.
- No DB-level CHECK constraint or trigger prevents double check-in on any domain (tickets, movie_tickets, turf_qr_tickets) — protection is application-only via conditional UPDATE predicates.

### Key configuration

All config lives in `src/config/index.ts` as a typed `config` object sourced from environment variables. A `.env` file is required (not committed). Critical env vars: `DATABASE_URL`, `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ORGANIZER_JWT_SECRET`, `QR_SIGNING_SECRET`, `REDIS_URL`, `CORS_ORIGIN`.

JWT expiry: customer 15m, admin 12h, organizer 8h. Global rate limit: 300 req/60s.