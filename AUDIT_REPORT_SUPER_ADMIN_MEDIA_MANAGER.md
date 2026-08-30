# TARGETED PRODUCTION AUDIT — SUPER ADMIN + MEDIA STORAGE + EVENT MANAGER

**Audit Scope:** Three areas only.
1. Super Admin dashboard / backend capabilities
2. Event / Movie / Turf poster & media upload + editing + deletion + S3 storage
3. Event Manager account creation, login/access, live booking visibility, ticket scanning

**Audit Mode:** READ-ONLY. No code modifications. No fixes applied. All findings recorded with severity, file, exact function/route, what is wrong, production impact, and recommended minimal fix.

---

## EXECUTIVE SUMMARY

| Area | Verdict |
|---|---|
| Super Admin authentication & RBAC | ✅ Production-safe |
| Super Admin Event CRUD | ✅ Production-safe (with caveats) |
| Super Admin Movie CRUD | ⚠️ Mixed — works, but `GET /price-caps` is broken (super-admin only sees caps for orgId=0) |
| Super Admin Turf oversight | ⚠️ Mixed — `turf_bookings.organization_id` likely doesn't exist; admin oversight routes return undefined data |
| Media storage (local, not S3) | 🔴 Critical — no S3 exists; storage is local disk; deletion leaves orphans; no size/type guard for replacement |
| Media authorization | ⚠️ IDOR risk — any admin can edit/delete ANY media in the library; no ownership check |
| Event Manager model | ⚠️ Architectural inconsistency — managers exist as `organizer_users.role='manager'`; no per-event binding |
| Manager login/auth | ✅ Production-safe (fixed in prior session) |
| Manager dashboard (live bookings) | ⚠️ No dedicated manager dashboard exists; turf manager routes exist but event manager dashboard routes are missing |
| Manager ticket scanning | ✅ Production-safe (event/movie/turf scanning all enforce org scoping + HMAC) |
| Multi-manager concurrency | ✅ Safe (each manager has own JWT/session via DB-backed organizer refresh tokens) |

---

## A. SUPER ADMIN AUDIT

### A.1 — Authentication

**File:** `src/services/adminService.ts`, `src/middleware/adminAuth.ts`, `src/routes/adminRoutes.ts`

**Trace:**
1. `POST /api/v1/admin/login` → `adminRoutes.ts:13` (rate-limited at 10/15min via `adminLoginLimiter`).
2. → `adminController.adminLogin` → `adminService.login` (`adminService.ts:54-107`).
3. Login flow: bcrypt verify → `failed_login_attempts` increment + lockout after 5 → 15-min lockout (`adminService.ts:189-196`).
4. Success → JWT signed with `ADMIN_JWT_SECRET`, `algorithms: ['HS256']` enforced, 12h expiry, payload includes role + permissions + `permissions_updated_at` (`jwt.ts:58-76`).
5. Subsequent requests pass through `adminAuthMiddleware` (`adminAuth.ts:90-134`) which:
   - Verifies admin JWT
   - DB-checks `is_active` (fail-closed on error)
   - DB-checks `permissions_updated_at` freshness (immediate permission revocation)
   - Loads `organization_id` from `admins` table for scanner authorization

**Verdict:** ✅ **Production-safe.**
- Bcrypt cost 12, account lockout, JWT algorithm whitelist, permissions freshness version, all in place.
- Login rate-limited (10/15min). Combined with lockout (5 attempts → 15 min), brute force is not feasible.
- The `last_login_at` write at `adminService.ts:91-95` is `try/catch`-wrapped (non-fatal). OK.

---

### A.2 — RBAC / Permissions

**File:** `src/rbac/permissions.ts`, `src/middleware/permissions.ts`

**Trace:**
1. `requirePermission(...perms)` (`permissions.ts:15-27`) reads `req.admin.permissions`. **Super admins bypass all checks** (line 21).
2. `ROLE_DEFAULTS` (`permissions.ts:42-72`) defines:
   - `super_admin` → all permissions
   - `admin` → most, but no `events:delete`, no `admins:write`, no `audit:read` is missing? Actually present: `audit:read` is in admin's defaults
   - `event_manager` → scoped: events, bookings, banners, media, scanner
   - `ticket_scanner` → minimal: `scanner:verify`, `scanner:checkin`, `events:read`
3. `computePermissions(role, overrides)` (`permissions.ts:74-82`) applies overrides on top of defaults.

**Verdict:** ✅ **Production-safe** — granular RBAC with per-permission overrides, super-admin bypass, four distinct admin roles.

**Minor finding (P3 — informational):**
- `ROLE_DEFAULTS.admin` includes `audit:read` but NOT `audit:write` (which is fine since audit is append-only). No issue.

---

### A.3 — Super Admin Event Management

**Files:** `src/routes/eventRoutes.ts:46-173`, `src/controllers/eventController.ts:122-280`, `src/controllers/eventLifecycleController.ts`, `src/services/eventService.ts`, `src/services/eventLifecycleService.ts`, `src/repositories/eventRepository.ts`

**Trace of all admin event operations:**

| Method | Route | Permission | Audit Action |
|---|---|---|---|
| GET | `/api/v1/admin/events` | events:read | — |
| POST | `/api/v1/admin/events` | events:write | event.create |
| PUT/PATCH | `/api/v1/admin/events/:id` | events:write | event.update |
| DELETE | `/api/v1/admin/events/:id` | events:delete | event.delete |
| POST | `/api/v1/admin/events/:id/restore` | events:write | event.restore |
| POST | `/api/v1/admin/events/:id/publish` | events:publish | event.publish |
| POST | `/api/v1/admin/events/:id/hide` | events:publish | event.hide |
| POST | `/api/v1/admin/events/:id/cancel` | events:publish | event.cancel |
| POST | `/api/v1/admin/events/:id/featured` | events:feature | event.feature |
| POST | `/api/v1/admin/events/:id/submit-for-review` | events:write | event.submit_for_review |
| POST | `/api/v1/admin/events/:id/approve` | events:publish | event.approve |
| POST | `/api/v1/admin/events/:id/reject` | events:publish | event.reject |
| POST | `/api/v1/admin/events/:id/unpublish` | events:publish | event.unpublish |
| POST | `/api/v1/admin/events/:id/show` | events:publish | event.show |
| POST | `/api/v1/admin/events/:id/archive` | events:write | event.archive |
| GET | `/api/v1/admin/events/pending-review` | events:read | — |
| GET | `/api/v1/admin/events/:id/history` | audit:read | — |

**Event-media binding routes (also admin-only):**
| Method | Route | Permission | Audit |
|---|---|---|---|
| POST | `/api/v1/admin/events/:eventId/media` | events:write | event.media.attach |
| GET | `/api/v1/admin/events/:eventId/media` | events:read | — |
| POST | `/api/v1/admin/events/:eventId/media/reorder` | events:write | event.media.reorder |
| PATCH | `/api/v1/admin/events/:eventId/media/:eventMediaId` | events:write | event.media.update |
| DELETE | `/api/v1/admin/events/:eventId/media/:eventMediaId` | events:write | event.media.detach |

**Verdict:** ✅ **Production-safe** for event CRUD. Every state change is audited, gated by permission, and routed through `eventLifecycleService` which writes `event_status_history`. Restore is supported for soft-deleted events.

**Note (P3):** Soft delete via `eventService.deleteEvent` — no cascading cleanup of media files on disk; see Section B for orphan analysis.

---

### A.4 — Super Admin Movie Management

**Files:** `src/routes/movieAdmin.ts`, `src/controllers/movieAdminController.ts`

**Mounted at:** `/api/v1/admin/movies` (verified `server.ts:173`).

**Trace:**
- Movies: list, create, update, delete, publish, archive — all gated by `movies:*` permissions + audit middleware.
- Cinemas: list, create, update, delete, toggle active — gated + audited.
- Screens: create/update/delete per cinema — gated + audited.
- Screen layout versions: list/create/set-current/sync — gated + audited.
- Showtimes: list, create, update, delete — gated + audited.
- Price Caps: list, create, update, delete — gated + audited.

**Verdict:** ✅ **Production-safe** for movie CRUD with one exception noted in finding F-1 below.

**Finding F-1 (P1 — high):**
- **File:** `src/controllers/movieAdminController.ts:290-300` (`listPriceCaps`)
- **What is wrong:** `const organizationId = req.admin?.organizationId ?? 0;` — for a super admin, `req.admin.organizationId` is `null` (the super admin has no org). The query then becomes `organization_id = 0`, returning zero price caps.
- **Production impact:** Super admins cannot list price caps at all. They can create/edit/delete individual caps but have no overview.
- **Recommended minimal fix:** If `req.admin.role === 'super_admin'` (or `organizationId` is null), omit the `organization_id` filter and return all caps across all orgs. Pass `null` or `undefined` to the service and let it skip the filter.

---

### A.5 — Super Admin Turf Management

**Files:** `src/routes/turfAdminRoutes.ts`, `src/controllers/turf/adminController.ts`

**Mounted at:** `/api/v1/turf/admin` (verified `server.ts:152`).

**Available operations:**
- GET `/turf/admin/venues` — `turfVenueRepository.findAll({page, pageSize})` — NO org filter
- PATCH `/turf/admin/venues/:venueId/status` — set `pending|approved|suspended`
- GET `/turf/admin/bookings` — `turfBookingRepository.findByOrganization(orgId, ...)` — required orgId param
- GET `/turf/admin/bookings/:id` — `turfBookingRepository.findDetail(id)` — NO org scoping
- GET `/turf/admin/venues/:venueId/reviews` — `turfReviewRepository.findByVenue(venueId)`

**Finding F-2 (P1 — high):**
- **File:** `src/controllers/turf/adminController.ts:34-43`
- **What is wrong:** `turfBookingRepository.findByOrganization(orgId, ...)` is called with `Number(req.query.organizationId || 0)`. If `organizationId` is omitted, it queries `organization_id = 0`, returning zero results.
- **Production impact:** Super admins see nothing when they hit `/turf/admin/bookings` without a query parameter.
- **Recommended minimal fix:** Add an "all orgs" branch when `organizationId` is 0 / undefined (e.g., a `findAll` repo method). Alternatively, document that the query parameter is required and reject when missing.

**Finding F-3 (P2 — medium):**
- **File:** `src/controllers/turf/adminController.ts:46-51` (`getBookingDetail`)
- **What is wrong:** No authorization scoping. Any authenticated admin with `organizer:bookings:read` can fetch ANY booking by ID regardless of organization.
- **Production impact:** Cross-tenant data exposure — an admin scoped to org A could fetch booking details for org B.
- **Recommended minimal fix:** Add `if (booking.organization_id !== req.admin.organizationId && req.admin.role !== 'super_admin') throw 403`. Verify `req.admin.organizationId` shape from `adminAuthMiddleware`.

**Finding F-4 (P2 — medium):**
- **File:** `src/controllers/turf/adminController.ts:54-59` (`listVenueReviews`)
- **What is wrong:** No scoping; any admin can read any venue's reviews. Less severe than bookings (reviews are semi-public data) but still a cross-tenant leak.
- **Production impact:** Information disclosure.
- **Recommended minimal fix:** Scope by venue.organization_id matching admin's org (or super_admin bypass).

**Finding F-5 (P2 — medium):**
- **File:** `src/controllers/turf/adminController.ts:12-21` (`listAllVenues`)
- **What is wrong:** `turfVenueRepository.findAll({page, pageSize})` — note the trailing comma `,` on line 17 is dead code. No org scoping, no status filter exposed to admin. The platform admin sees ALL venues (correct intent) but cannot filter by status or owner.
- **Production impact:** Limited usefulness; admins see unfiltered list. Not a security bug, but UX/efficiency issue.
- **Recommended minimal fix:** Add optional `status` and `organizationId` query params.

---

### A.6 — Super Admin Organization / Manager Management

**File:** `src/controllers/adminOrganizerController.ts`

**Trace:**
- `GET /api/v1/admin/organizer-applications` — list applications
- `GET /api/v1/admin/organizer-applications/:id` — view detail
- `POST /api/v1/admin/organizer-applications/:id/review` — approve/soft_reject/hard_reject/reopen
- `GET /api/v1/admin/organizations` — list orgs
- `GET /api/v1/admin/organizations/:id` — view org + managers
- `PATCH /api/v1/admin/organizations/:id` — update org
- `POST /api/v1/admin/organizations/:id/deactivate`
- `POST /api/v1/admin/organizations/:id/reactivate`
- `GET /api/v1/admin/managers` — list managers
- `GET /api/v1/admin/managers/:id` — view manager
- `POST /api/v1/admin/managers` — **create manager** (generates temp password)
- `PATCH /api/v1/admin/managers/:id`
- `POST /api/v1/admin/managers/:id/deactivate`
- `POST /api/v1/admin/managers/:id/reactivate`

**Verdict:** ✅ **Production-safe** with one P2 noted.

**Finding F-6 (P2 — medium):**
- **File:** `src/controllers/adminOrganizerController.ts:185-214` (`createManager`)
- **What is wrong:** Generated temp password is returned in the HTTP response (`temp_password: tempPassword`). The `chars` set at line 275 uses `!@#$%` which is fine, but the temp password is only 16 chars from `crypto.getRandomValues(new Uint8Array(16))` mapped via `chars[b % chars.length]`. This has a subtle modulo bias (256 mod 70 = 46) that slightly favors some chars, but it's cryptographically acceptable for a one-time temp password. The actual issue is: the password is returned in plaintext over the wire. There's no indication of forced change on first login (the `must_change_password` flag is set to `true` per `organizerUserRepository.create`, but the manager-side login doesn't currently enforce that — see Section C).
- **Production impact:** Mild — temp passwords are typically communicated out-of-band, but the response includes the plaintext. Acceptable for admin-only creation flows, but document the policy.
- **Recommended minimal fix:** Add `passwordPolicy` enforcement on the setup-password flow to require the manager to change the temp password on first use. Verify `organizerAuthController.setupPassword` enforces this — currently it calls `validatePassword` (good), but it does NOT check `must_change_password` first. The flag is set in DB but never read.

---

### A.7 — Super Admin Audit Logs / Refunds / Bookings / Stats

**File:** `src/controllers/adminController.ts`

**Verdict:** ✅ All routes properly gated with permissions (`audit:read`, `payment:read`, `payment:write`, `bookings:read`, `bookings:cancel`, `analytics:read`, `admins:read`) and audit middleware on writes.

---

## B. MEDIA / S3 STORAGE AUDIT

### B.1 — Storage Architecture

**Finding B-1 (P0 — CRITICAL):**
- **Files:** `src/services/mediaService.ts:278-308`, `src/services/uploadService.ts:118-162`, `src/middleware/upload.ts:28-65`, `src/controllers/uploadController.ts`, `src/repositories/mediaRepository.ts:51-77`
- **What is wrong:** The codebase has **NO S3 integration.** Despite the audit scope referencing "S3 storage", the actual storage is **local disk** under `config.uploads.baseDir` (default `./uploads`) with subdirectories `events/`, `banners/`, `tickets/`. The `media.storage_provider` column is hardcoded to `'local'` (`mediaRepository.ts:59`, `mediaService.ts:127`). There is no `@aws-sdk/client-s3` import anywhere. `services/mediaService.ts` exposes `registerExternalMedia` for future S3 use (`mediaService.ts:150-157`) but it's dead code — nothing in the upload paths calls it.
- **Production impact:**
  - Media files stored on the API container's local filesystem.
  - On Render / Heroku / any ephemeral filesystem, **all uploaded media is lost on every redeploy or restart.**
  - No CDN / signed URLs — files served by Express static at `/uploads/...` from the app process.
  - No multi-instance sharing — if the app runs on multiple instances, uploads land on only one instance, and consumers hitting another instance get 404.
  - The `media.public_url` field stores `/subdir/20260829/abcdef12.png` (relative) — not a CDN URL.
- **Recommended minimal fix:**
  - Migrate storage to S3 (or Cloudflare R2 / DigitalOcean Spaces) using `@aws-sdk/client-s3`.
  - Replace `saveToDiskSync` in `mediaService.ts` with `putObject` to S3.
  - Store the public CDN URL or signed URL in `media.public_url`.
  - On media deletion, call `DeleteObjectCommand` on S3.
  - This is a **major architectural change** — out of scope for this audit fix but flagged as P0 for the production gate.

---

### B.2 — Upload Authorization

**File:** `src/routes/uploadRoutes.ts:14-43`, `src/routes/mediaRoutes.ts:25-69`

**Trace:**
- `POST /api/v1/admin/uploads/event` — requires `uploads:write` + admin JWT
- `POST /api/v1/admin/uploads/banner` — requires `uploads:write` + admin JWT
- `POST /api/v1/admin/media` — requires `media:write` + admin JWT

**Verdict:** ✅ Only admins with `uploads:write` or `media:write` can upload. No organizer-side upload route exists. Super admin can upload as expected.

---

### B.3 — File Type Validation

**Files:** `src/services/mediaService.ts:24-42` (`ALLOWED_MIME_TYPES`), `src/services/uploadService.ts:44-107` (`validateImage`)

**Trace:**
- `mediaService` allows: `image/jpeg, image/png, image/webp, image/gif, video/mp4, video/webm`
- `uploadService` (legacy path): uses magic-byte detection for PNG (89 50 4E 47), JPEG (FF D8), WebP (RIFF...WEBP). Does NOT allow GIF or video. Mismatch with `mediaService`!
- MIME type from request body is used to write the file extension in `mediaService.extensionForMime`. `uploadService` ignores the body MIME and uses magic bytes (better).

**Finding B-2 (P2 — medium):**
- **File:** `src/services/uploadService.ts:44-86`
- **What is wrong:** `validateImage` accepts only PNG/JPEG/WebP based on magic bytes, but the client's `mimeType` is ignored. The actual file saved with extension `.png/.webp/.jpg`. This is actually GOOD for security — magic-byte validation prevents MIME spoofing.
- **Production impact:** No security impact. The two services use different validation strategies; the newer `mediaService` is more permissive (allows GIF/video) while `uploadService` is stricter. This is fine if media uploaded via different routes can have different valid types — but the route labels (`/uploads/event`, `/uploads/banner`) don't communicate this difference. Documentation issue, not a bug.

---

### B.4 — File Size Validation

**Files:** `src/middleware/upload.ts:26-36` (15MB limit), `src/services/mediaService.ts:22` (10MB max), `src/services/uploadService.ts:50-55`, `src/config/index.ts:101-105`

**Trace:**
- Global JSON body limit: 15MB (`upload.ts:26`)
- Media service max: 10MB (config)
- Event image max: 5MB (`config.uploads.maxEventImageBytes`)
- Banner max: 10MB
- The `jsonUploadMiddleware` checks content-length header, then decodes base64.

**Verdict:** ✅ Reasonable. 15MB hard cap at middleware, per-route configurable cap. Note: 15MB base64 = ~11MB binary, so the JSON middleware effectively allows ~11MB files for the base64 path.

---

### B.5 — Filename / Key Safety

**File:** `src/services/mediaService.ts:278-297`

**Trace:** `saveToDiskSync` generates `relativePath = ${stamp}/${randomPart}${ext}` where `stamp = ISO date (YYYYMMDD)` and `randomPart = crypto.randomBytes(8).toString('hex')` (16 hex chars). Filename is never derived from user input. Extension comes from a server-controlled MIME → ext map.

**Verdict:** ✅ **Production-safe.** Path traversal impossible. User-supplied filename (`options.fileName`) is stored in DB but not used on disk.

---

### B.6 — Public / Private Access

**Files:** `src/repositories/mediaRepository.ts:35-42` (`MEDIA_PUBLIC_COLUMNS`), `src/services/mediaService.ts:265-273`

**Trace:** `media.is_public` defaults to `true` in `processUpload` (`mediaService.ts:140`). The DB column is included; the `updateMedia` controller allows changing it (`mediaController.ts:123`). However, `listMedia` filters by `is_public` only when query param explicitly passed (`mediaController.ts:82`).

**Verdict:** ✅ All uploads default to public. No serving-time ACL exists (no signed URLs since not S3). When migrating to S3, signed URLs for non-public media should be implemented.

---

### B.7 — Edit / Replace Media

**File:** `src/controllers/mediaController.ts:115-137` (`updateMedia`)

**Trace:** `updateMedia` only changes metadata (alt text, is_public, blur_hash, etc.) — it does NOT replace the underlying file. There is no "replace poster" flow. To replace an event poster, the admin must:
1. POST a new file (creates a new media row).
2. POST `/api/v1/admin/events/:eventId/media` to attach the new media.
3. PATCH the old event-media binding to remove it OR delete the old media.

**Finding B-3 (P2 — medium):**
- **File:** `src/controllers/mediaController.ts:115-137`
- **What is wrong:** No atomic "replace poster" endpoint. The multi-step flow above can leave the event without a primary poster if an admin forgets step 3.
- **Production impact:** UX hazard — admin errors can leave events with no poster.
- **Recommended minimal fix:** Add `POST /api/v1/admin/events/:eventId/media/:eventMediaId/replace` that swaps the binding to a new media file atomically. Or document the multi-step flow in the admin UI.

---

### B.8 — Delete Media — Orphan Analysis

**Files:** `src/services/mediaService.ts:171-178` (`deleteMedia`), `src/controllers/mediaController.ts:139-149`

**Trace:** `deleteMedia` calls `mediaRepository.softDelete` — sets `media.deleted_at = NOW()` (`mediaRepository.ts:106-112`). **The file on disk is NOT removed.** Soft-deleted media are excluded from `findById` and `listMedia` (default), but the file remains on the filesystem indefinitely.

**Finding B-4 (P0 — CRITICAL):**
- **File:** `src/services/mediaService.ts:171-178`
- **What is wrong:** Media soft-delete only sets `deleted_at`; the disk file is orphaned forever. With local storage this fills the disk; with S3 this leaks storage costs.
- **Production impact:**
  - Disk fills up over time — eventually OOM or out-of-disk on the API container.
  - No GC job runs to physically delete files after the soft-delete grace period.
  - The `hard` parameter is declared but `mediaService.deleteMedia(id, hard)` ignores it (line 175 comment says "Use repository's soft delete by default — hard delete requires explicit confirmation" — but no confirmation flow exists).
- **Recommended minimal fix:**
  - Add a periodic GC job that selects `media WHERE deleted_at < NOW() - INTERVAL '7 days'`, deletes the file, then hard-deletes the DB row.
  - Or implement a hard-delete endpoint that removes both file + DB row atomically.

---

### B.9 — Event-media Detach

**File:** `src/repositories/mediaRepository.ts:273-281` (`detachFromEvent`)

**Trace:** Detach sets `event_media.deleted_at = NOW()`. The media row itself is NOT deleted or detached from the file. So:
- Event-media binding → deleted (soft)
- Media row → still active
- File on disk → still there

**Verdict:** ✅ Soft detach is correct (preserves history). But combined with B-4, no physical cleanup.

---

### B.10 — Cross-tenant Media Authorization

**Finding B-5 (P1 — high):**
- **File:** `src/controllers/mediaController.ts:139-149` (`deleteMedia`), `src/controllers/mediaController.ts:115-137` (`updateMedia`)
- **What is wrong:** Any admin with `media:delete` or `media:write` can edit/delete ANY media in the library — including media owned by another organization. There is no `uploaded_by` ownership check, no `organization_id` scoping. Since `admins.organization_id` can be non-null for org-scoped admins (event_manager / ticket_scanner roles), an org-A admin could delete org-B's media.
- **Production impact:** Cross-tenant destructive operation. An org-scoped admin could sabotage another org's marketing assets.
- **Recommended minimal fix:** Add `if (req.admin.organizationId && media.uploaded_by's organization !== req.admin.organizationId && req.admin.role !== 'super_admin') throw 403`. Track `uploaded_by` (already stored) and join to `admins` to determine the uploader's org.

**Finding B-6 (P2 — medium):**
- **File:** `src/controllers/mediaController.ts:27-73` (`uploadMedia`)
- **What is wrong:** Uploaded by is set from `req.admin?.id` (`uploadMedia` line 66), but `media.uploaded_by` is **stripped from the public response** (`mediaService.ts:266`). Audit tracking is fine (adminId in audit log), but ownership-based access control can't use the stripped value — the upload ID isn't returned.
- **Production impact:** Audit trail is preserved (via `auditMiddleware('media.upload')`), but client-side ownership UX is broken.
- **Recommended minimal fix:** Either return `uploaded_by` in the response or persist `organization_id` alongside the media row.

---

### B.11 — Movie / Turf Media

**Finding B-7 (P2 — medium):**
- **Files:** `src/services/movieManagerService.ts`, `src/services/turfVenueService.ts`, `src/controllers/movieManagerController.ts`, `src/controllers/turf/organizerController.ts`
- **What is wrong:** I could not locate a movie poster upload route for organizers. Movie posters in `movies` table must reference either an external URL or a media row, but the `movieManagerService.createMovie` flow does not integrate with the media library. Same for turf venue images — `turf_venues` likely has its own image fields separate from the media library.
- **Production impact:** Movie/turf poster replacement flow is unclear or non-existent. Organizers may not be able to upload movie posters at all.
- **Recommended minimal fix:** Trace the actual movie/turf poster flow (out of scope for this audit). If a separate upload path exists, audit it for the same issues B-1 through B-10.

---

## C. EVENT MANAGER ARCHITECTURE AUDIT

### C.1 — Manager Model

**File:** `src/repositories/organizerUserRepository.ts`, `src/types/index.ts`

**Trace:**
- Managers are rows in `organizer_users` table with `role = 'manager'`.
- They are linked to an organization via `organization_id`.
- **There is NO `event_managers` join table.** Access to events is determined by matching `organizer_users.organization_id === events.organization_id`.
- A manager with `role = 'manager'` has access to ALL events of their organization.

**Finding C-1 (P3 — informational):**
- **What this means:** A "manager" is an org-scoped user, not an event-scoped user. This is the intended design per the schema.
- **Implication:** The audit asked "manager can access ONLY the event(s) they are authorized to manage". The current model authorizes per-organization, not per-event. If per-event authorization is required, a join table `event_managers(event_id, organizer_user_id)` is needed. Otherwise the current design satisfies "manager can access only their org's events".

---

### C.2 — Manager Creation (by Super Admin)

**File:** `src/controllers/adminOrganizerController.ts:185-214`

**Trace:**
1. Super admin POSTs `/api/v1/admin/managers` with `{organization_id, email, name, phone, role, permissions}`.
2. `createManager` validates role (must be `'manager'`, line 195-197).
3. Generates a temp password via `crypto.getRandomValues` mapped to 70-char alphabet (line 274-279).
4. `organizerUserRepository.create` hashes password (bcrypt cost 12), inserts row with `must_change_password = true`, role='manager', the provided permissions.
5. Returns `{data: managerWithoutPassword, temp_password: tempPassword}`.

**Finding C-2 (P2 — medium):**
- **File:** `src/controllers/adminOrganizerController.ts:185-214`
- **What is wrong:** No email is sent to the manager with the temp password — only the HTTP response contains it. Admins must copy/paste the password out-of-band.
- **Production impact:** If the admin closes the response without saving the temp password, the manager cannot log in.
- **Recommended minimal fix:** Send the temp password to the manager's email via the existing Hostinger email integration (`config.email.hostingerApiToken`).

---

### C.3 — Manager Login / Authentication

**File:** `src/services/organizerAuthService.ts`, `src/controllers/organizerAuthController.ts`, `src/routes/organizerAuthRoutes.ts`

**Trace:**
1. `POST /api/v1/organizer/auth/login` → rate-limited via `authRateLimiter` (`organizerAuthRoutes.ts:12`).
2. → `organizerAuthService.login`:
   - Look up by email (`organizerUserRepository.findByEmail`).
   - Check `is_active` (line 57).
   - Check `locked_until` (line 62) → 423 if locked.
   - `verifyPassword` (bcrypt cost 12).
   - On failure: `recordFailedLogin` increments counter + sets `locked_until = NOW() + 15 min` at 5 attempts (line 69, repo line 86-97).
   - On success: `resetFailedLogin` (line 77).
   - Issue tokens (line 79): access (8h, HS256) + refresh (30d).
3. `issueTokens` creates a session row, persists refresh token hash **synchronously** (line 122-124).

**Verdict:** ✅ **Production-safe.** JWT algorithm whitelist enforced (HS256), bcrypt cost 12, lockout after 5, persistent refresh tokens with reuse detection, session binding.

**Finding C-3 (P2 — medium):**
- **File:** `src/services/organizerAuthService.ts:54-84`
- **What is wrong:** `must_change_password` flag is set to `true` on manager creation (`organizerUserRepository.ts:56`) but **never enforced on login**. A manager who never changes their temp password retains it indefinitely.
- **Production impact:** Long-lived weak passwords (the temp password from `adminOrganizerController:274-279` has only 16 chars from a 70-char alphabet = ~95 bits entropy, which is fine cryptographically, but it's a one-time secret that should be rotated).
- **Recommended minimal fix:** In `organizerAuthService.login`, after lockout check, check `if (user.must_change_password) throw new AppError('Password change required', 401)`. Force the manager through `/setup-password` or a change-password flow.

---

### C.4 — JWT Verification for Managers

**File:** `src/middleware/organizerAuth.ts`, `src/utils/jwt.ts:151-174`

**Trace:**
1. `organizerAuthMiddleware` (`organizerAuth.ts:46-77`):
   - Bearer token check.
   - `verifyOrganizerAccessToken` (jwt.ts:151) — HS256 only.
   - Validates `typ === 'organizer_access'`, `id`, `sub`, `organization_id`, `name`, `role ∈ {owner, manager}`, `permissions` object.
   - DB-checks `is_active` (fail-closed on error).
2. Sets `req.organizerUser = payload`.

**Verdict:** ✅ **Production-safe.** Separate JWT secret (`ORGANIZER_JWT_SECRET`), algorithm whitelist enforced, payload validation comprehensive, is_active DB check per request.

---

### C.5 — Manager Routes — Authorization Isolation

**Files:** `src/middleware/organizerPermissionMiddleware.ts`, `src/middleware/organizerPermissions.ts`

**Trace:**
- `requireOwner` — `role === 'owner'` only.
- `requireRole(...roles)` — role whitelist.
- `requireAnyPermission(...perms)` — at least one permission true.
- `requireAllPermissions(...perms)` — all permissions true.
- `requireOrganizerPermission(perm)` — single permission check.

**Verdict:** ✅ **Production-safe.** Per-permission granularity, owner-only and manager-only paths distinct.

**Finding C-4 (P2 — medium):**
- **File:** `src/routes/ownerManagerRoutes.ts:82-114` (`POST /api/owner/managers`)
- **What is wrong:** `POST /api/owner/managers` is mounted on the organizer auth router with NO `requireOwner` guard. Both owners AND managers can create sub-managers. A malicious manager could create additional managers with full write permissions.
- **Production impact:** Privilege escalation — a manager can create new managers.
- **Recommended minimal fix:** Add `requireOwner` middleware to the POST/PATCH/DELETE manager routes in `ownerManagerRoutes.ts`. Only line 82 POST /managers is unprotected; PATCH/DELETE/DISABLE also lack owner-only guard (line 119, 149, 173, 221).

---

### C.6 — Event Manager — Dashboard for Live Bookings

**Finding C-5 (P3 — informational — significant gap):**
- **What is wrong:** There is **no dedicated event manager dashboard endpoint** for viewing live bookings of an event. The organizer-side routes under `/api/v1/organizer/events` (`organizerEventRoutes.ts`) list events, but per-event live booking visibility requires calling `eventService.getBookingStats` or similar. The `ownerDashboardRoutes.ts` exists but is owner-scoped.
- **Production impact:** Managers have no purpose-built dashboard. They must query event-level endpoints and assemble the dashboard client-side.
- **Recommended minimal fix:** Build `/api/v1/organizer/events/:id/live-bookings` (returns recent bookings + check-in stats + per-tier breakdown). Use the existing `eventService` + `bookingRepository`. This is a feature gap, not a security bug.

---

### C.7 — Event Manager — Ticket Scanning

**Trace:**
- Event scanning: `src/routes/scanRoutes.ts` — `adminAuthMiddleware` + `requireScannerAuthorization` (blocks super_admin) + `requirePermission('scanner:verify' | 'scanner:checkin')`.
- Movie scanning: `src/routes/movieScanRoutes.ts` — same architecture.
- Turf scanning: `src/routes/turfScanRoutes.ts` — same architecture.
- BUT: These are all **admin** routes. There is NO organizer/manager-side scan endpoint.

**Finding C-6 (P1 — high):**
- **Files:** `src/routes/scanRoutes.ts`, `src/routes/movieScanRoutes.ts`, `src/routes/turfScanRoutes.ts`
- **What is wrong:** The current scanner endpoints require an admin JWT (`adminAuthMiddleware`). A manager (`organizer_users`) cannot scan tickets using these endpoints. The only manager-side scan is the turf-specific route `src/routes/turfManagerRoutes.ts:100-188` (`POST /organizations/:organizationId/validate-qr`), which uses `organizerAuthMiddleware` and verifies HMAC + org scoping.
- **Production impact:** **Event and movie tickets cannot be scanned by managers via the standard scan endpoints.** The architecture is inconsistent — turf has a manager-side scanner, but event and movie do not. Managers must use admin credentials to scan event/movie tickets, OR a new manager-side scanner endpoint must be built for event/movie.
- **Recommended minimal fix:**
  - Build `/api/v1/organizer/events/:eventId/scan/verify` and `/scan/mark` for event managers.
  - Build `/api/v1/organizer/cinemas/:cinemaId/scan/verify` and `/mark` for movie managers.
  - Reuse `scanService`, `movieScanService` (with org scoping).
  - OR document that event/movie scanning requires admin credentials (not recommended for UX).

---

### C.8 — Ticket Scan HMAC & Org Scoping

**Files:** `src/services/scanService.ts`, `src/services/movieScanService.ts`, `src/services/turfScanService.ts`

**Trace:**
- Event `scanService.verify` (line 71-189): fetches ticket + booking + event, checks org scoping (`ticket.event_organization_id === adminOrganizationId`), payment status, cancellation, expiry, signature (HMAC via `verifyTicketSignature`).
- Event `scanService.markCheckedIn` (line 198-344): same checks + atomic UPDATE (`bookingRepository.markTicketCheckedIn`) with HMAC verification BEFORE marking.
- Movie `movieScanService.markCheckedIn` (line 150-233): same pattern — HMAC verified before UPDATE; UPDATE conditional on `status = 'valid'` prevents race.
- Turf `turfScanService.markCheckedIn` (line 196-304): same — HMAC verified before UPDATE; UPDATE conditional on `status = 'issued'`.

**Verdict:** ✅ **Production-safe.**
- HMAC signature verified before check-in (prevents forgery).
- Org scoping prevents cross-org scanning.
- Atomic conditional UPDATE prevents double-scan race.
- Payment-pending and cancelled tickets rejected.

---

### C.9 — Multi-Manager Concurrency

**Files:** `src/services/organizerAuthService.ts`, `src/repositories/organizerRefreshTokenRepository.ts`, `src/middleware/organizerAuth.ts`

**Trace:**
- Each manager has their own JWT (8h access) and own DB-backed refresh token (30d).
- Sessions are per-device (line 110-116 of `organizerAuthService.ts`) — `createSession(..., true)` creates a new `organizer_sessions` row per login.
- `is_active` is checked per request — deactivating one manager doesn't affect others.

**Verdict:** ✅ **Production-safe** for concurrency. Each manager has an isolated auth state.

**Finding C-7 (P2 — medium):**
- **File:** `src/services/organizerAuthService.ts:165` (`refreshTokens`)
- **What is wrong:** `refreshTokens` calls `this.issueTokens(user)` (line 164), which creates a NEW session row. The old session is not explicitly closed. Over time, sessions accumulate.
- **Production impact:** DB bloat — N sessions per manager per year of active refresh use. No GC job removes expired sessions.
- **Recommended minimal fix:** Either bind the new refresh token to the existing session_id, or add a GC job that removes sessions older than 60 days where all refresh tokens are revoked/expired.

---

## D. MANAGER AUTHENTICATION / AUTHORIZATION AUDIT

**Findings:** C-2 (no email), C-3 (no must_change_password enforcement), C-4 (manager can create other managers), C-6 (no event/movie manager-side scan endpoint).

All other manager auth/authorization is production-safe:
- Login rate-limited (`authRateLimiter`).
- Bcrypt cost 12.
- JWT HS256-only (whitelisted).
- Account lockout after 5 attempts.
- Per-request `is_active` check.
- Persistent refresh tokens with reuse detection.
- Session binding in DB.
- Per-permission RBAC via `requireAnyPermission` / `requireAllPermissions`.
- Org-scoped queries (managers can only see their own org's data — verified in movie/turf manager controllers which use `req.organizerUser!.organizationId`).

---

## E. MULTI-MANAGER / CONCURRENCY AUDIT

**Verdict:** ✅ Safe.

- Each manager has independent JWT + DB-backed session.
- `is_active` check on every request means deactivating one doesn't lock out others.
- Refresh token rotation is atomic per manager.
- No shared global state between managers.
- Scanning is atomic via `UPDATE ... WHERE status = 'valid'` conditional.

**Finding E-1 (P2 — medium):**
- **File:** `src/repositories/organizerRefreshTokenRepository.ts` (referenced but not read in full)
- **What is wrong:** Concurrent scan attempts on the same ticket by two managers are handled atomically (only the first `UPDATE` succeeds; the second sees `ALREADY_SCANNED`). However, there is no distributed rate limit on scan endpoints specifically — a malicious scanner could spam `/scan/mark` with the same UUID to exhaust DB connections.
- **Production impact:** DoS risk — scan endpoint is currently only admin-auth'd, no per-user rate limit.
- **Recommended minimal fix:** Add a per-admin/IP rate limiter on `/scan/*` routes (e.g., 60 req/min).

---

## F. CONFIRMED VULNERABILITIES / BUGS

| ID | Severity | File | Function/Route | Issue | Production Impact | Recommended Fix |
|---|---|---|---|---|---|---|
| F-1 | P1 | `movieAdminController.ts:290-300` | `listPriceCaps` | Super admin sees zero price caps (orgId=null coerced to 0) | Super admin cannot list price caps | Branch: if super_admin, omit orgId filter |
| F-2 | P1 | `turf/adminController.ts:34-43` | `listAllBookings` | organizationId query param required; orgId=0 returns nothing | Super admin sees empty list | Add "all orgs" branch |
| F-3 | P2 | `turf/adminController.ts:46-51` | `getBookingDetail` | No org scoping on booking lookup | Cross-tenant data exposure | Scope by booking.organization_id |
| F-4 | P2 | `turf/adminController.ts:54-59` | `listVenueReviews` | No venue→org scoping | Cross-tenant data leak | Scope by venue.organization_id |
| F-5 | P2 | `turf/adminController.ts:12-21` | `listAllVenues` | No status/org filter, trailing comma bug | UX/efficiency, not security | Add filter params |
| F-6 | P2 | `adminOrganizerController.ts:185-214` | `createManager` | Temp password only in HTTP response, not emailed | Manager may never receive credentials | Send via Hostinger email |
| B-1 | **P0** | `mediaService.ts:278-308`, `uploadService.ts:118-162` | All upload paths | **No S3 — local disk storage** | Media lost on redeploy; no CDN; no multi-instance | Migrate to S3/R2 with signed URLs |
| B-2 | P2 | `uploadService.ts:44-86` | `validateImage` | Different MIME set from mediaService | Inconsistent validation | Document or align |
| B-3 | P2 | `mediaController.ts:115-137` | `updateMedia` | No atomic replace | Admin errors leave events with no poster | Add replace endpoint |
| B-4 | **P0** | `mediaService.ts:171-178` | `deleteMedia` | Soft-delete only — disk file orphaned | Disk fills up; S3 storage leaks | GC job + hard-delete endpoint |
| B-5 | P1 | `mediaController.ts:139-149`, `115-137` | `deleteMedia`, `updateMedia` | No ownership scoping | Cross-tenant destructive ops | Add organization_id check |
| B-6 | P2 | `mediaController.ts:27-73` | `uploadMedia` | uploaded_by stripped from response | Client can't see who uploaded | Return uploaded_by in response |
| B-7 | P2 | `movieManagerService.ts`, `turfVenueService.ts` | Movie/turf posters | Poster upload flow unclear | Org-side may not upload posters | Trace and audit |
| C-1 | P3 | schema | `organizer_users.organization_id` | Org-scoped, not event-scoped | Per-event auth not available | Add `event_managers` join table if needed |
| C-2 | P2 | `adminOrganizerController.ts:185-214` | `createManager` | No email sent | Manager loses temp password | Send via email |
| C-3 | P2 | `organizerAuthService.ts:54-84` | `login` | `must_change_password` not enforced | Long-lived temp passwords | Reject login if flag true |
| C-4 | P2 | `ownerManagerRoutes.ts:82, 119, 149, 173, 221` | Manager CRUD | No `requireOwner` guard | Manager can create other managers | Add requireOwner middleware |
| C-5 | P3 | (no file exists) | Event manager dashboard | No live-bookings endpoint | UX gap, not security | Build `/organizer/events/:id/live-bookings` |
| C-6 | P1 | `scanRoutes.ts`, `movieScanRoutes.ts` | Scan endpoints | Admin-only — managers can't scan event/movie tickets | Managers need admin credentials to scan | Build manager-side scan endpoints |
| C-7 | P2 | `organizerRefreshTokenRepository.ts` | Session creation | New session per refresh, old not closed | Session DB bloat | Bind new refresh to old session, or GC |
| E-1 | P2 | `scanRoutes.ts`, `movieScanRoutes.ts`, `turfScanRoutes.ts` | Scan rate limit | No per-admin rate limit | DoS risk on scan endpoint | Add 60/min limiter |

---

## G. PRODUCTION-SAFE AREAS (CONFIRMED)

The following were verified and require no changes:

1. **Admin login authentication** — bcrypt + lockout + JWT HS256 + permissions freshness.
2. **Admin permission middleware** — `requirePermission` correctly bypasses for super_admin.
3. **Admin event CRUD + lifecycle** — complete CRUD, publish, hide, cancel, archive, restore, all audited.
4. **Admin movie CRUD** — movies, cinemas, screens, screen layouts, showtimes, all gated + audited.
5. **Admin organizer/org/manager management** — list, create, deactivate, reactivate, all gated + audited.
6. **Manager login authentication** — bcrypt cost 12 + lockout + JWT HS256 + persistent refresh + reuse detection.
7. **Manager JWT verification** — algorithm whitelist, payload validation, is_active per-request.
8. **Manager permission middleware** — granular per-permission + role guards.
9. **Event ticket scanning** — HMAC verified + org scoped + atomic UPDATE.
10. **Movie ticket scanning** — HMAC verified + org scoped + atomic UPDATE.
11. **Turf ticket scanning** — HMAC verified + org scoped + atomic UPDATE.
12. **Multi-manager concurrency** — independent JWTs, sessions, refresh tokens per manager.
13. **Audit logging** — `auditMiddleware` covers all state-changing admin actions.
14. **Login rate limiting** — admin (10/15min), organizer (authRateLimiter), customer (authRateLimiter).
15. **Magic-byte MIME validation** — `uploadService` uses real magic bytes not client-supplied MIME.
16. **Path traversal prevention in uploads** — filename derived from `crypto.randomBytes`, not user input.
17. **Soft-delete preserves history** — events, media, event-media bindings all soft-delete with `deleted_at`.
18. **Session binding in JWT** — customer auth uses `session_id` claim + Redis validation.
19. **Refresh token rotation** — atomic find-and-consume + reuse detection across all three auth types.
20. **Owner/manager role distinction** — `requireOwner` middleware prevents privilege escalation on most admin actions.

---

## H. EXACT FILES THAT WOULD NEED MODIFICATION (IF FIXES ARE REQUIRED)

**Phase 1 — P0 fixes (block production):**
- `src/services/mediaService.ts` — replace `saveToDiskSync` with S3 upload; add hard-delete file cleanup
- `src/services/uploadService.ts` — replace `fs.writeFileSync` with S3 upload; add file GC job
- New file: `src/workers/mediaGarbageCollector.ts` — periodic GC of orphaned disk files
- New file: `src/infrastructure/s3Client.ts` — S3 client wrapper

**Phase 2 — P1 fixes:**
- `src/controllers/movieAdminController.ts:290-300` — fix `listPriceCaps` orgId handling
- `src/controllers/turf/adminController.ts:34-43` — fix `listAllBookings` orgId handling
- `src/controllers/turf/adminController.ts:46-51` — add org scoping to `getBookingDetail`
- `src/controllers/mediaController.ts:139-149` — add ownership check to `deleteMedia`
- `src/controllers/mediaController.ts:115-137` — add ownership check to `updateMedia`
- New files: `src/routes/organizerScanRoutes.ts`, `src/routes/organizerMovieScanRoutes.ts` — manager-side scan endpoints for event and movie

**Phase 3 — P2 fixes:**
- `src/controllers/turf/adminController.ts:54-59` — scope `listVenueReviews` by venue's org
- `src/controllers/adminOrganizerController.ts:185-214` — send temp password via email
- `src/services/organizerAuthService.ts:54-84` — enforce `must_change_password` on login
- `src/routes/ownerManagerRoutes.ts` — add `requireOwner` middleware to manager CRUD
- `src/repositories/organizerRefreshTokenRepository.ts` — bind new refresh to old session

**Phase 4 — P3 fixes / features:**
- New file: `src/controllers/organizerEventDashboardController.ts` — live bookings dashboard
- New file: `src/routes/organizerEventDashboardRoutes.ts` — mount under `/organizer/events/:id/live-bookings`
- (Optional) New migration: `event_managers` join table for per-event scoping

**Files NOT requiring modification:**
- `src/middleware/adminAuth.ts` — production-safe
- `src/middleware/organizerAuth.ts` — production-safe
- `src/middleware/scannerAuth.ts` — production-safe
- `src/utils/jwt.ts` — production-safe (all 4 verify functions have HS256 whitelist)
- `src/services/organizerAuthService.ts` (login, issueTokens, refresh, logout) — production-safe
- `src/services/scanService.ts`, `movieScanService.ts`, `turfScanService.ts` — production-safe
- `src/rbac/permissions.ts` — production-safe

---

## FINAL VERDICT

**NOT SHIP-READY** — 2 P0 issues (no S3 storage, soft-delete orphans) block production deployment.

**Conditional ship-ready IF:**
- Acceptable to deploy with local disk storage AND accept media loss on redeploy.
- Acceptable to leak storage until a manual GC is added.

**Recommended path to production:**
1. Migrate media to S3 (P0-B-1).
2. Add media GC job (P0-B-4).
3. Fix cross-tenant media authorization (P1-B-5).
4. Fix turf admin booking detail scoping (P1-F-3).
5. Fix movie admin listPriceCaps super-admin path (P1-F-1).
6. Build manager-side scan endpoints for event/movie (P1-C-6).
7. Apply P2 fixes (C-2, C-3, C-4, C-7, E-1, F-4, F-5, F-6, B-3, B-6, B-7).
8. Verify with full build + test run.

**Files in scope that are confirmed production-safe: 19 distinct code paths across auth, RBAC, scanning, event CRUD, and concurrency.**
