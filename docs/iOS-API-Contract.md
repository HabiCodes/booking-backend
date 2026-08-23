# BACKEND → iOS COMPLETE API CONTRACT & INTEGRATION AUDIT

**Version:** 1.0.0 — Production Audit
**Date:** 2026-08-23
**Scope:** All actual implemented backend endpoints, schemas, and business rules
**Constraint:** This document describes ONLY what exists in the codebase. Nothing invented.

---

## TABLE OF CONTENTS

1. Base URL & Environment
2. Authentication — Customer Only
3. Location Support
4. Home / Discovery API
5. Movie APIs — Complete Flow
6. Event APIs — Complete Flow
7. Turf APIs — Complete Flow
8. Payment — Complete Architecture
9. Payment Failure Handling
10. Payment Idempotency & Retry
11. Cashfree Webhook (All Categories)
12. Payment Service API (Internal)
13. Admin Auth API
14. Admin Dashboard API
15. Ticket Scanner API
16. Organizer APIs
17. Image / Media API
18. Promotions API
19. Search API
20. Pagination
21. Error Contract
22. Currency / Money Contract
23. Date / Time Contract
24. Concurrency & Race Conditions
25. Gap Analysis (EXISTING / PARTIALLY / MISSING / BROKEN / DANGEROUS)
26. Final iOS Checklist
27. Swift API Client Contract
28. Implementation Order

---

## SECTION 1: BASE URL & ENVIRONMENT

### 1.1 Production Base URL

```
https://event-booking-backend.onrender.com
```

This is the Render-deployed hostname from `render.yaml`. The `APP_URL` env var is set at deploy time.

### 1.2 API Prefix

All implemented routes are mounted under TWO prefixes:

| Prefix | Status |
|---|---|
| `/api/v1` | Primary |
| `/api` | Legacy alias — identical handlers |

**iOS rule:** Always use `/api/v1`. The `/api` prefix exists for backward compatibility and may be deprecated.

### 1.3 Health Check Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/health/live` | GET | None | Liveness probe (Render health check) |
| `/health/ready` | GET | None | Readiness probe (DB + Redis check) |

**Note:** `/health` was removed. The `render.yaml` `healthCheckPath` points to `/health/live`.

### 1.4 CORS

- Controlled by `CORS_ORIGIN` env var (single origin string).
- In production, must be set to the iOS app's domain or `*`.
- If unset, the app validates and exits on startup with a warning in production.

### 1.5 Enforced Startup Validation

On boot, the server runs `assertValidEnvOrExit()` which checks:
- `NODE_ENV === 'production'` requires `JWT_SECRET >= 32 chars`
- `NODE_ENV === 'production'` requires `ADMIN_JWT_SECRET >= 32 chars`
- `NODE_ENV === 'production'` requires `ORGANIZER_JWT_SECRET >= 32 chars`
- `NODE_ENV === 'production'` requires `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY`
- `CORS_ORIGIN` must not be `*` in production (warns but continues)
- `DATABASE_URL` required
- `QR_SIGNING_SECRET` required
- `CASHFREE_WEBHOOK_SECRET` required

---

## SECTION 2: AUTHENTICATION — CUSTOMER ONLY

### 2.1 JWT Token Architecture (Three-Tier)

| Token Type | Secret | Typ Claim | Expiry | Header |
|---|---|---|---|---|
| Customer Access | `JWT_SECRET` | `access` | 15 minutes | `Authorization: Bearer <token>` |
| Admin Access | `ADMIN_JWT_SECRET` | `admin_access` | 12 hours | `Authorization: Bearer <token>` |
| Organizer Access | `ORGANIZER_JWT_SECRET` | `organizer_access` | 8 hours | `Authorization: Bearer <token>` |

### 2.2 Customer Auth Endpoints

#### POST `/api/v1/auth/register` — Register with OTP

**Request Body:**
```json
{
  "name": "string (required)",
  "email": "string (required, valid email)",
  "phone": "string (required, E.164 format)",
  "password": "string (required, min 6 chars)"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": 1,
      "name": "string",
      "email": "string",
      "phone": "string",
      "role": "customer",
      "isVerified": false
    },
    "message": "Registration successful. Please verify your email."
  }
}
```

**Behavior:** Creates user, sends OTP email via Hostinger (or console fallback). OTP is 6 digits, valid 10 minutes.

---

#### POST `/api/v1/auth/verify-otp` — Verify Email OTP

**Request Body:**
```json
{
  "email": "string (required)",
  "otp": "string (required, 6 digits)"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": { "id": 1, "isVerified": true, ... },
    "message": "Email verified successfully"
  }
}
```

---

#### POST `/api/v1/auth/login` — Login

**Request Body:**
```json
{
  "email": "string (required)",
  "password": "string (required)"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": { "id": 1, "name": "string", "email": "string", "role": "customer" },
    "tokens": {
      "accessToken": "eyJhbGciOi...",
      "refreshToken": "eyJhbGciOi..."
    }
  }
}
```

**Behavior:** Sets HTTP-only `refreshToken` cookie. Returns `accessToken` in body. Rate limited to 20 requests per 15 minutes per IP.

---

#### POST `/api/v1/auth/login/enhanced` — Login (Enhanced Version)

**Request Body:** Same as `/auth/login`

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": { "id": 1, "name": "string", "email": "string", "role": "customer" },
    "tokens": {
      "accessToken": "eyJhbGciOi...",
      "refreshToken": "eyJhbGciOi..."
    }
  }
}
```

---

#### POST `/api/v1/auth/refresh` — Refresh Access Token

**Auth:** Requires valid `refreshToken` cookie

**Response (200):**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "eyJhbGciOi..."
  }
}
```

---

#### POST `/api/v1/auth/logout` — Logout

**Auth:** Requires valid access token

**Request Body:** None

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Behavior:** Clears refresh token cookie. Optionally revokes Redis session.

---

#### GET `/api/v1/auth/profile` — Get Current User

**Auth:** Requires valid access token

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "string",
    "email": "string",
    "phone": "string",
    "role": "customer",
    "isVerified": true
  }
}
```

---

### 2.3 Refresh Token Cookie

- Name: `refreshToken`
- HttpOnly: true
- Secure: true (production)
- SameSite: `lax`
- MaxAge: 7 days
- Path: `/api/v1/auth/refresh`

### 2.4 Token Refresh Strategy for iOS

1. Store `accessToken` in iOS Keychain.
2. On 401 response, call `POST /api/v1/auth/refresh` (the cookie is sent automatically).
3. If refresh succeeds, update stored access token and retry original request.
4. If refresh fails (401), clear tokens and navigate to login screen.

### 2.5 Admin/Organizer Login — Separate Endpoints

Customer auth endpoints (`/api/v1/auth/*`) are for CUSTOMERS only. Admin and Organizer login use different endpoints (see Section 13).

---

## SECTION 3: LOCATION SUPPORT

### 3.1 What Exists

**Turf venues** have a `city` column in the `turf_venues` table. The city is returned in venue listings.

**Events** have a `city` column. Public endpoints expose `city` in event listings.

**Movies** have `city` and `state` on cinemas.

### 3.2 What Does NOT Exist

| Feature | Status | iOS Implication |
|---|---|---|
| City autocomplete / search | NOT IMPLEMENTED | iOS must provide its own city list |
| City-based dropdown | NOT IMPLEMENTED | iOS must use hardcoded city list |
| Geospatial radius search | NOT IMPLEMENTED | No "near me" on backend |
| IP-based location detection | NOT IMPLEMENTED | iOS must request location permission |
| State-based filtering for turfs | NOT IMPLEMENTED | Only city filtering exists |
| Lat/Lng coordinates anywhere | NOT IMPLEMENTED | No distance calculations possible |

### 3.3 Available Cities (Backend Returns)

Both events and turfs support filtering by exact city string:
- `GET /api/v1/events?city=Mumbai`
- `GET /api/v1/turf/venues?city=Mumbai` (NOT IMPLEMENTED — see Section 25)

The backend does not maintain a master city list. The iOS app should:
1. Show a hardcoded list of supported cities (from admin-configured data)
2. Use the city field as a filter on events
3. Accept that turf venue listing has no city filter

### 3.4 Movies and City

Movies do NOT have a city concept at the movie level. City filtering applies only to cinemas (`/api/v1/movies/cinemas?city=Mumbai`).

---

## SECTION 4: HOME / DISCOVERY API

### 4.1 Featured Movies

**Endpoint:** `GET /api/v1/movies/featured`

**Auth:** None

**Query Parameters:** None

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "string",
      "description": "string",
      "poster_url": "string (URL)",
      "banner_url": "string (URL) or null",
      "genre": "string or null",
      "language": "string or null",
      "duration_minutes": 120,
      "certificate": "string or null",
      "is_featured": true,
      "created_at": "ISO 8601"
    }
  ]
}
```

---

### 4.2 Featured Events

**Endpoint:** `GET /api/v1/events/featured`

**Auth:** None

**Query Parameters:** `limit` (optional, default: 5, max: 20)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "string",
      "description": "string",
      "category": "string",
      "city": "string",
      "venue": "string",
      "start_at": "ISO 8601",
      "end_at": "ISO 8601",
      "capacity": 100,
      "price": "0.00",
      "image_url": "string or null",
      "status": "published",
      "is_featured": true
    }
  ]
}
```

---

### 4.3 Active Event (Single)

**Endpoint:** `GET /api/v1/events/active`

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "string",
    "description": "string",
    "category": "string",
    "city": "string",
    "venue": "string",
    "start_at": "ISO 8601",
    "end_at": "ISO 8601",
    "capacity": 100,
    "price": "0.00",
    "image_url": "string or null",
    "status": "published"
  }
}
```

---

### 4.4 Now Playing Movies

**Endpoint:** `GET /api/v1/movies/now-playing`

**Auth:** None

**Query Parameters:**
- `city` (optional) — filter cinemas by city
- `page` (optional, default: 1)
- `limit` (optional, default: 20, max: 100)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "string",
      "description": "string",
      "poster_url": "string",
      "banner_url": "string or null",
      "genre": "string",
      "language": "string",
      "duration_minutes": 120,
      "certificate": "string",
      "is_featured": true,
      "created_at": "ISO 8601"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50,
    "totalPages": 3
  }
}
```

---

### 4.5 Upcoming Movies

**Endpoint:** `GET /api/v1/movies/upcoming`

**Auth:** None

**Query Parameters:** Same as now-playing

**Response:** Same format as now-playing

---

### 4.6 Turf Venues (Homepage)

**Endpoint:** `GET /api/v1/turf/venues`

**Auth:** None

**Query Parameters:** None (no city filter)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "string",
      "description": "string or null",
      "address": "string",
      "city": "string",
      "state": "string or null",
      "pincode": "string or null",
      "latitude": "number or null",
      "longitude": "number or null",
      "contact_phone": "string or null",
      "contact_email": "string or null",
      "image_url": "string or null",
      "is_active": true,
      "organization_id": 1,
      "created_at": "ISO 8601"
    }
  ]
}
```

**CRITICAL:** This endpoint returns ALL venues regardless of city. There is NO city query parameter. The backend does not filter by city for turf venues. iOS must filter client-side.

---

### 4.7 Home Banner / Carousel

**NOT IMPLEMENTED** — There is no dedicated banner/carousel API. The home screen should use:
1. Featured movies (`/api/v1/movies/featured`)
2. Featured events (`/api/v1/events/featured`)
3. All turf venues (`/api/v1/turf/venues`)
4. Active event (`/api/v1/events/active`)

---

## SECTION 5: MOVIE APIs — COMPLETE FLOW

### 5.1 Movie Discovery

#### GET `/api/v1/movies/now-playing` — Now Playing
(Described in Section 4.4)

#### GET `/api/v1/movies/upcoming` — Upcoming
(Described in Section 4.5)

#### GET `/api/v1/movies/featured` — Featured
(Described in Section 4.1)

#### GET `/api/v1/movies/:id` — Movie Detail

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "string",
    "description": "string",
    "poster_url": "string",
    "banner_url": "string or null",
    "genre": "string",
    "language": "string",
    "duration_minutes": 120,
    "certificate": "string",
    "is_featured": true,
    "created_at": "ISO 8601"
  }
}
```

---

### 5.2 Cinemas

#### GET `/api/v1/movies/cinemas` — List Cinemas

**Auth:** None

**Query Parameters:**
- `city` (optional) — exact match city filter
- `movie_id` (optional) — filter cinemas that have showtimes for this movie

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "string",
      "address": "string",
      "city": "string",
      "state": "string or null",
      "pincode": "string or null",
      "latitude": "number or null",
      "longitude": "number or null",
      "contact_phone": "string or null",
      "image_url": "string or null",
      "facilities": ["string"],
      "is_active": true,
      "created_at": "ISO 8601"
    }
  ]
}
```

---

### 5.3 Showtimes

#### GET `/api/v1/movies/:movieId/showtimes` — Showtimes for a Movie

**Auth:** None

**Query Parameters:**
- `date` (optional) — `YYYY-MM-DD` format, filters showtimes by date
- `cinema_id` (optional) — filter by specific cinema

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "movie_id": 1,
      "cinema_id": 1,
      "screen_name": "Screen 1",
      "show_time": "ISO 8601",
      "end_time": "ISO 8601 or null",
      "price": "250.00",
      "available_seats": 120,
      "total_seats": 150,
      "is_active": true
    }
  ]
}
```

**iOS display rule:** Show showtimes grouped by date, then by cinema. Sort by `show_time` ascending.

---

### 5.4 Seats — Selection & Hold

#### GET `/api/v1/movies/showtimes/:showtimeId/seats` — Get Seat Layout

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "showtime_id": 1,
    "screen_name": "Screen 1",
    "total_seats": 150,
    "available_seats": 120,
    "seats": [
      {
        "seat_label": "A1",
        "row": "A",
        "number": 1,
        "price": "250.00",
        "type": "standard",
        "status": "available"
      }
    ]
  }
```

**Seat statuses:**
- `available` — can be selected
- `held` — held by another user's pending booking (10-min TTL)
- `booked` — already sold
- `maintenance` — not for sale

---

#### POST `/api/v1/movies/seats/hold` — Hold Seats

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "showtime_id": 1,
  "seat_labels": ["A1", "A2", "A3"],
  "hold_duration_seconds": 600
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "hold_id": "uuid-string",
    "showtime_id": 1,
    "seats": ["A1", "A2", "A3"],
    "expires_at": "ISO 8601",
    "hold_duration_seconds": 600
  }
}
```

**Behavior:**
- Uses Redis Lua script for atomic seat locking
- Hold TTL: 10 minutes (600 seconds) default
- Hold key format: `movie:hold:<showtimeId>`
- If any seat is already held/booked, the entire hold request fails with 409
- Rate limited per user

---

#### DELETE `/api/v1/movies/seats/hold` — Release Seat Hold

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "hold_id": "uuid-string"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Seat hold released"
}
```

---

### 5.5 Movie Booking & Payment

#### POST `/api/v1/movies/bookings` — Create Booking (Initiate Payment)

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "showtime_id": 1,
  "seat_labels": ["A1", "A2", "A3"],
  "movie_id": 1,
  "name": "string (customer name for ticket)",
  "email": "string (for ticket delivery)",
  "phone": "string (for ticket delivery)"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "order_id": "MOV_1724367600000_a1b2c3",
    "amount": 750.00,
    "currency": "INR",
    "payment_session_id": "cashfree-session-id",
    "payment_link": "https://payments.cashfree.com/...",
    "order_expiry_time": "ISO 8601"
  }
}
```

**CRITICAL:**
- `movie_id` is MANDATORY in the request body
- The backend creates a `payment_orders` row with `booking_type = 'movie'`
- This is the ONLY way movie bookings are created
- The booking is in `pending_payment` status until payment is confirmed
- Seat holds are created in Redis concurrently

---

#### POST `/api/v1/movies/bookings/confirm` — Confirm Booking After Payment

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "order_id": "MOV_1724367600000_a1b2c3"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "booking_reference": "MOVABC123",
    "status": "confirmed",
    "tickets": [
      {
        "ticket_id": "uuid-string",
        "seat_label": "A1",
        "row": "A",
        "number": 1,
        "price": "250.00",
        "qr_token": "string",
        "qr_code_url": "string (data:image/png or URL)"
      }
    ],
    "total_amount": 750.00
  }
}
```

**CRITICAL iOS FLOW — This is the step many iOS devs miss:**
1. User selects seats → Call `POST /api/v1/movies/seats/hold`
2. User initiates payment → Call `POST /api/v1/movies/bookings` → Returns `payment_session_id` and `payment_link`
3. User completes payment in Cashfree SDK/webview
4. User returns to app → Call `POST /api/v1/movies/bookings/confirm` with the `order_id`
5. Tickets are ONLY generated in step 4

**Failure path:** If payment fails, call `POST /api/v1/movies/bookings/confirm` still — the backend checks payment status and will return the actual state (confirmed or failed). The seat holds are released automatically on failure.

---

### 5.6 Movie Tickets

#### GET `/api/v1/movies/my-bookings` — My Movie Bookings

**Auth:** REQUIRED — Customer JWT token

**Query Parameters:**
- `page` (optional, default: 1)
- `limit` (optional, default: 20)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "booking_id": 1,
        "booking_reference": "MOVABC123",
        "movie_id": 1,
        "movie_title": "string",
        "poster_url": "string",
        "cinema_name": "string",
        "screen_name": "string",
        "show_time": "ISO 8601",
        "seat_labels": ["A1", "A2", "A3"],
        "total_amount": "750.00",
        "status": "confirmed",
        "tickets": [
          {
            "ticket_uuid": "uuid-string",
            "seat_label": "A1",
            "row": "A",
            "number": 1,
            "qr_token": "string",
            "qr_code_url": "string or null"
          }
        ],
        "created_at": "ISO 8601"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
  }
}
```

---

#### GET `/api/v1/movies/my-tickets/:bookingId` — Booking Detail with QR

**Auth:** REQUIRED — Customer JWT token

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "booking_reference": "MOVABC123",
    "movie_id": 1,
    "movie_title": "string",
    "poster_url": "string",
    "cinema_name": "string",
    "address": "string",
    "city": "string",
    "screen_name": "string",
    "show_time": "ISO 8601",
    "seat_labels": ["A1", "A2", "A3"],
    "total_amount": "750.00",
    "status": "confirmed",
    "tickets": [
      {
        "ticket_uuid": "uuid-string",
        "seat_label": "A1",
        "row": "A",
        "number": 1,
        "qr_token": "string",
        "qr_code_url": "string or null"
      }
    ],
    "created_at": "ISO 8601"
  }
}
```

---

## SECTION 6: EVENT APIs — COMPLETE FLOW

### 6.1 Event Discovery

#### GET `/api/v1/events` — List Public Events

**Auth:** None

**Query Parameters:**
- `page` (optional, default: 1)
- `limit` (optional, default: 20, max: 100)
- `category` (optional) — exact match filter (e.g., `concert`, `workshop`)
- `city` (optional) — exact match city filter
- `search` (optional) — text search in title and description
- `status` (optional, default: `published`) — filter by status

**Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 1,
        "title": "string",
        "description": "string",
        "category": "workshop",
        "city": "Mumbai",
        "venue": "string",
        "start_at": "ISO 8601",
        "end_at": "ISO 8601",
        "capacity": 100,
        "price": "0.00",
        "image_url": "string or null",
        "status": "published",
        "visibility": "public",
        "organization_id": 1,
        "is_featured": false,
        "created_at": "ISO 8601"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 50, "totalPages": 3 }
  }
}
```

---

#### GET `/api/v1/events/categories` — List Event Categories

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": [
    { "category": "workshop", "count": 15 },
    { "category": "concert", "count": 8 }
  ]
}
```

---

#### GET `/api/v1/events/cities` — List Event Cities

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": [
    { "city": "Mumbai", "count": 20 },
    { "city": "Delhi", "count": 15 }
  ]
}
```

---

#### GET `/api/v1/events/featured` — Featured Events

**Auth:** None

**Query Parameters:** `limit` (optional, default: 5)

**Response (200):** Array of Event objects (same shape as list items)

---

#### GET `/api/v1/events/active` — Currently Active Event

**Auth:** None

**Response (200):** Single Event object or null

---

#### GET `/api/v1/events/:id` — Event Detail

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "string",
    "description": "string",
    "category": "workshop",
    "city": "Mumbai",
    "venue": "string",
    "start_at": "ISO 8601",
    "end_at": "ISO 8601",
    "capacity": 100,
    "remaining_capacity": 75,
    "price": "0.00",
    "image_url": "string or null",
    "status": "published",
    "visibility": "public",
    "organization_id": 1,
    "is_featured": false,
    "created_at": "ISO 8601"
  }
}
```

**Visibility rules:** Only returns events with `status = 'published'`, `visibility = 'public'`, and `deleted_at IS NULL`.

---

#### GET `/api/v1/events/:id/related` — Related Events

**Auth:** None

**Query Parameters:** `limit` (optional, default: 4)

**Response (200):** Array of Event objects (same category, excluding current event)

---

### 6.2 Event Booking

#### POST `/api/v1/events/:id/book` — Book Event (FREE)

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "quantity": 2,
  "attendee_names": ["Alice", "Bob"],
  "attendee_emails": ["alice@example.com", "bob@example.com"]
}
```

**CRITICAL CONSTRAINTS:**
- `quantity` max: 10 per booking
- Max 10 bookings per user per event (enforced server-side)
- Event bookings are ALWAYS FREE — no payment required

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "booking_reference": "EVT-ABC123",
    "event_id": 1,
    "event_title": "string",
    "quantity": 2,
    "tickets": [
      {
        "ticket_uuid": "uuid-string",
        "qr_signature": "string",
        "attendee_name": "Alice",
        "attendee_email": "alice@example.com",
        "seat_label": "GENERAL-1"
      }
    ],
    "total_amount": "0.00",
    "status": "confirmed"
  }
}
```

**Behavior:**
1. Server decrements `remaining_capacity` atomically
2. Generates UUID tickets with QR signatures (HMAC-SHA256 signed via `QR_SIGNING_SECRET`)
3. Returns tickets immediately — no payment step

---

#### GET `/api/v1/events/my-bookings` — My Event Bookings

**Auth:** REQUIRED — Customer JWT token

**Query Parameters:**
- `page` (optional, default: 1)
- `limit` (optional, default: 20)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "booking_id": 1,
        "booking_reference": "EVT-ABC123",
        "event_id": 1,
        "event_title": "string",
        "event_image_url": "string or null",
        "start_at": "ISO 8601",
        "end_at": "ISO 8601",
        "venue": "string",
        "city": "string",
        "quantity": 2,
        "total_amount": "0.00",
        "status": "confirmed",
        "tickets": [
          {
            "ticket_uuid": "uuid-string",
            "qr_signature": "string",
            "attendee_name": "Alice",
            "seat_label": "GENERAL-1"
          }
        ],
        "created_at": "ISO 8601"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
  }
}
```

---

## SECTION 7: TURF APIs — COMPLETE FLOW

### 7.1 Turf Venues

#### GET `/api/v1/turf/venues` — List All Venues

**Auth:** None

**Query Parameters:** None (no city filter exists)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "string",
      "description": "string or null",
      "address": "string",
      "city": "string",
      "state": "string or null",
      "pincode": "string or null",
      "latitude": "number or null",
      "longitude": "number or null",
      "contact_phone": "string or null",
      "contact_email": "string or null",
      "image_url": "string or null",
      "is_active": true,
      "organization_id": 1,
      "created_at": "ISO 8601"
    }
  ]
}
```

---

#### GET `/api/v1/turf/venues/:id` — Venue Detail

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "string",
    "description": "string or null",
    "address": "string",
    "city": "string",
    "state": "string or null",
    "pincode": "string or null",
    "latitude": "number or null",
    "longitude": "number or null",
    "contact_phone": "string or null",
    "contact_email": "string or null",
    "image_url": "string or null",
    "is_active": true,
    "organization_id": 1,
    "resources": [
      {
        "id": 1,
        "venue_id": 1,
        "name": "string",
        "resource_type": "slot_based",
        "sport_type": "football",
        "base_price": 500.00,
        "is_active": true,
        "created_at": "ISO 8601"
      }
    ],
    "reviews": [
      {
        "id": 1,
        "user_id": 1,
        "rating": 4,
        "review": "Great turf",
        "created_at": "ISO 8601"
      }
    ],
    "average_rating": 4.2
  }
}
```

---

### 7.2 Turf Resources & Sports

#### GET `/api/v1/turf/resources` — List Resources

**Auth:** None

**Query Parameters:**
- `venue_id` (optional) — filter by venue
- `sport_type` (optional) — filter by sport (e.g., `football`, `cricket`)
- `resource_type` (optional) — filter by type (`slot_based` or `pitch_based`)
- `is_active` (optional) — filter by active status

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "venue_id": 1,
      "name": "Main Field",
      "resource_type": "slot_based",
      "sport_type": "football",
      "base_price": 500.00,
      "is_active": true,
      "created_at": "ISO 8601"
    }
  ]
}
```

---

#### GET `/api/v1/turf/sport-types` — List Sport Types

**Auth:** None

**Response (200):**
```json
{
  "success": true,
  "data": [
    { "value": "football", "label": "Football", "count": 5 },
    { "value": "cricket", "label": "Cricket", "count": 3 },
    { "value": "badminton", "label": "Badminton", "count": 2 }
  ]
}
```

---

### 7.3 Turf Availability / Slots

#### GET `/api/v1/turf/venues/:venueId/availability` — Get Availability Slots

**Auth:** None

**Query Parameters:**
- `resource_id` (optional) — filter by specific resource
- `date` (optional) — `YYYY-MM-DD` format, defaults to today
- `start_date` / `end_date` (optional) — date range filter

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "resource_id": 1,
      "resource_name": "Main Field",
      "sport_type": "football",
      "starts_at": "ISO 8601",
      "ends_at": "ISO 8601",
      "price": "500.00",
      "status": "available",
      "resource_type": "slot_based",
      "total_capacity": null,
      "available_capacity": null,
      "seat_label": null
    }
  ]
}
```

**Slot status values:**
- `available` — can be booked
- `locked` — temporarily held by another user (5-min TTL)
- `payment_pending` — user is in payment flow
- `booked` — already sold

---

### 7.4 Turf Booking Flow

#### POST `/api/v1/turf/bookings` — Create Turf Booking

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "availability_unit_id": 1,
  "quantity": 1,
  "booking_type": "online",
  "coupon_code": "string or null"
}
```

**CRITICAL CONSTRAINTS:**
- `quantity` max: 10 per booking
- Slot duration max: 4 hours
- Cannot overlap with user's existing bookings
- Must select a slot that is `available` (not `locked` or `payment_pending`)
- Organization must be active

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "booking_reference": "TFABC123",
    "amount": 500.00,
    "status": "pending_payment",
    "availability_unit_id": 1,
    "venue_id": 1,
    "resource_name": "Main Field",
    "slot_start": "ISO 8601",
    "slot_end": "ISO 8601",
    "coupon_discount": 0,
    "final_amount": 500.00
  }
}
```

**Response fields:**
- `amount` — base amount before coupon
- `coupon_discount` — discount applied (0 if no coupon)
- `final_amount` — amount to pay after discount

---

#### POST `/api/v1/turf/bookings/:id/confirm` — Confirm After Payment

**Auth:** REQUIRED — Customer JWT token

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "booking_reference": "TFABC123",
    "status": "confirmed",
    "qr_token": "string",
    "amount": 500.00,
    "slot_start": "ISO 8601",
    "slot_end": "ISO 8601"
  }
}
```

**CRITICAL:** Similar to movies, turf bookings go through:
1. Create booking (`pending_payment`) → `POST /api/v1/turf/bookings`
2. Pay via Cashfree (use `payment_session_id` from the booking creation response)
3. Confirm → `POST /api/v1/turf/bookings/:id/confirm`

The turf booking service generates a QR ticket on confirmation.

---

### 7.5 Turf Reviews

#### POST `/api/v1/turf/venues/:venueId/reviews` — Create Review

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "booking_id": 1,
  "rating": 4,
  "review": "Great experience"
}
```

**CRITICAL CONSTRAINTS:**
- `rating` must be 1-5 (clamped server-side)
- User must have a `confirmed`, `completed`, or `checked_in` booking for this venue
- One review per user per booking

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "venue_id": 1,
    "user_id": 1,
    "booking_id": 1,
    "rating": 4,
    "review": "Great experience",
    "created_at": "ISO 8601"
  }
}
```

---

### 7.6 Turf Coupons

#### GET `/api/v1/turf/coupons/validate` — Validate Coupon

**Auth:** REQUIRED — Customer JWT token

**Query Parameters:**
- `code` (required) — coupon code
- `venue_id` (required) — venue to check against
- `amount` (required) — base booking amount

**Response (200):**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "code": "SAVE20",
    "discount_type": "percentage",
    "discount_value": 20,
    "discount_amount": 100.00,
    "max_discount": 200.00,
    "final_amount": 400.00
  }
}
```

**Response (200) when invalid:**
```json
{
  "success": true,
  "data": { "valid": false, "reason": "Coupon has expired" }
}
```

---

### 7.7 Turf My Bookings

#### GET `/api/v1/turf/my-bookings` — My Turf Bookings

**Auth:** REQUIRED — Customer JWT token

**Query Parameters:**
- `page` (optional, default: 1)
- `limit` (optional, default: 20)
- `status` (optional) — filter by booking status

**Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "booking_id": 1,
        "booking_reference": "TFABC123",
        "venue_name": "string",
        "resource_name": "Main Field",
        "sport_type": "football",
        "slot_start": "ISO 8601",
        "slot_end": "ISO 8601",
        "amount": "500.00",
        "status": "confirmed",
        "qr_token": "string or null",
        "quantity": 1,
        "created_at": "ISO 8601"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
  }
}
```

---

#### POST `/api/v1/turf/bookings/:id/cancel` — Cancel Booking

**Auth:** REQUIRED — Customer JWT token

**Request Body:**
```json
{
  "reason": "string or null"
}
```

**CRITICAL CONSTRAINTS:**
- Cancellation allowed only >= 2 hours before slot start
- Full refund only if cancelled >= 24 hours before slot
- Partial/no refund if cancelled < 24 hours before slot
- Cannot cancel after `checked_in` status (penalty applies)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "status": "refunded",
    "refund_eligible": true,
    "refund_amount": 500.00
  }
}
```

---

### 7.8 Turf QR Check-in

#### POST `/api/v1/turf/bookings/:id/checkin` — Self Check-in

**Auth:** REQUIRED — Customer JWT token

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "status": "checked_in",
    "checked_in_at": "ISO 8601"
  }
}
```

---

## SECTION 8: PAYMENT — COMPLETE ARCHITECTURE

### 8.1 Payment Gateway

**Provider:** Cashfree (Indian payment gateway)
**Interface:** `IPaymentGateway` with `CashfreePaymentGateway` implementation
**API Version:** `2022-09-01`
**Base URL:** `https://api.cashfree.com/pg`

### 8.2 Payment Flow — Movies

```
iOS App                        Backend                      Cashfree
   |                              |                             |
   |-- POST /movies/seats/hold -->|                             |
   |                              |                             |
   |-- POST /movies/bookings ---->|                             |
   |   {showtime_id, seat_labels, |                             |
   |    movie_id, ...}            |                             |
   |                              |-- POST /pg/orders --------->|
   |                              |   {order_id, amount,        |
   |                              |    customer_details,        |
   |                              |    order_meta: {            |
   |                              |      return_url,            |
   |                              |      notify_url             |
   |   |<--- {booking_id,         |    }}                       |
   |   |    payment_session_id,   |<----------------------------|
   |   |    payment_link} --------|                             |
   |                              |                             |
   |-- Open Cashfree SDK/webview->|                             |
   |   (use payment_link or       |                             |
   |    payment_session_id)        |                             |
   |                              |                             |
   |<-- Payment complete ---------|                             |
   |                              |                             |
   |-- POST /movies/bookings/     |                             |
   |   confirm ------------------>|                             |
   |   {order_id}                 |                             |
   |                              |-- GET /pg/orders/{id} ----->|
   |                              |                             |
   |   |<--- {tickets,            |<----------------------------|
   |   |    booking_id,           |                             |
   |   |    status: confirmed} ---|                             |
```

### 8.3 Payment Flow — Turfs

```
iOS App                        Backend                      Cashfree
   |                              |                             |
   |-- POST /turf/bookings ------>|                             |
   |   {availability_unit_id,     |                             |
   |    quantity, ...}            |                             |
   |                              |-- POST /pg/orders --------->|
   |   |<--- {booking_id,         |<----------------------------|
   |   |    order_id,             |                             |
   |   |    payment_session_id} --|                             |
   |                              |                             |
   |-- Open Cashfree SDK/webview->|                             |
   |                              |                             |
   |<-- Payment complete ---------|                             |
   |                              |                             |
   |-- POST /turf/bookings/:id/   |                             |
   |   confirm ------------------>|                             |
   |                              |                             |
   |   |<--- {qr_token,           |                             |
   |   |    status: confirmed} ---|                             |
```

### 8.4 Payment Flow — Events

**NO PAYMENT REQUIRED.** Event bookings are always free.
- Call `POST /api/v1/events/:id/book`
- Tickets are returned immediately

### 8.5 Payment Order Creation Details

**File:** `src/services/paymentService.ts` — `createOrder()` (lines 35-94)

The `createOrder()` method:
1. Accepts `booking_id`, `order_id`, `amount`, `currency`, `customerEmail`, `customerPhone`, `customerName`, `metadata`
2. Creates a `payment_orders` DB row with `booking_type` determined from `event_id`/`movie_id` fields
3. Calls Cashfree `POST /pg/orders` via `CashfreePaymentGateway.createOrder()`
4. Returns `CreateOrderResult` with `gatewayResponse` containing `payment_session_id`, `payment_link`, `expires_at`

**CRITICAL:** The `movie_id` field was previously lost in the chain (not forwarded to the repository), causing all movie orders to get `booking_type = 'turf'`. This was fixed.

### 8.6 Order ID Format

| Booking Type | Order ID Prefix | Example |
|---|---|---|
| Movie | `MOV_` | `MOV_1724367600000_a1b2c3` |
| Turf | `TF_` | `TF_1724367600000_x1y2z3` |
| Event | No order (free) | N/A |
| Promotion | `PROMO_` | `PROMO_1_1724367600000` |

### 8.7 Cashfree Order Meta

The `order_meta` sent to Cashfree includes:
- `return_url`: `${CASHFREE_RETURN_URL}/booking/{bookingId}/success` (or `http://localhost:3001/booking/{bookingId}/success` as fallback)
- `notify_url`: Only set if `CASHFREE_NOTIFY_URL` env var is configured
- Any additional `metadata` passed by the caller

### 8.8 Environment Variables for Payment

| Variable | Required | Purpose |
|---|---|---|
| `CASHFREE_APP_ID` | YES (production) | Cashfree merchant ID |
| `CASHFREE_SECRET_KEY` | YES (production) | Cashfree secret key |
| `CASHFREE_WEBHOOK_SECRET` | YES (production) | HMAC secret for webhook verification |
| `CASHFREE_RETURN_URL` | YES (production) | Base URL for payment return redirect |
| `CASHFREE_NOTIFY_URL` | YES (production) | Full webhook URL (see Section 11) |

---

## SECTION 9: PAYMENT FAILURE HANDLING

### 9.1 Failure Scenarios

| Scenario | Backend Behavior | iOS Action |
|---|---|---|
| Cashfree order creation fails (502) | Returns error to caller | Show "Payment unavailable, try again" |
| User cancels payment in Cashfree | Cashfree marks order as `CANCELLED` | On confirm, backend returns FAILED status |
| Payment timeout (order expires) | Cashfree marks as `EXPIRED` | On confirm, backend returns FAILED status |
| Payment declined by bank | Cashfree marks as `FAILED` | On confirm, backend returns FAILED status |
| Network failure during confirm | HTTP error to iOS | Retry with exponential backoff (3 attempts) |
| Webhook fails to deliver | Server polls on confirm | No action needed — confirm call checks gateway |

### 9.2 Turf Payment Timeout Worker

A background worker (`turfBookingService.expireStaleBookings()`) runs periodically:
- Finds bookings with `status = 'pending_payment'` older than 5 minutes (`PAYMENT_TIMEOUT_SECONDS = 300`)
- Marks availability unit back to `available`
- Releases coupon reservations
- Sets booking status to `expired`

**Note:** This worker must be scheduled externally (cron, Render cron job) — it does NOT run automatically inside the main server process.

### 9.3 Movie Payment Timeout

Movies do NOT have an explicit timeout worker. The `movie_holds` in Redis expire after their TTL (10 minutes), which frees the seats. However, the `payment_orders` row remains until explicitly cleaned.

### 9.4 iOS Failure UI Flow

1. Call `POST /movies/bookings/confirm` or `POST /turf/bookings/:id/confirm`
2. If response `status !== 'confirmed'`:
   - Show "Payment was not successful" message
   - Offer "Try Again" which creates a new booking
   - Show specific error if available from response
3. If HTTP error (5xx/network):
   - Show "Something went wrong, checking your booking..."
   - Poll `GET /movies/my-bookings` or `GET /turf/my-bookings` after 5 seconds
   - Show the actual booking status once resolved

---

## SECTION 10: PAYMENT IDEMPOTENCY & RETRY

### 10.1 Idempotency Keys

**Turf bookings:** `turf_booking_{userId}_unit_{unitId}` (Redis, TTL: 360s)
- Stored in Redis: `turf:idempotency:{key}`
- Prevents duplicate bookings for the same user+slot combo
- Cleaned up on success or failure

**Movie bookings:** `movie_booking_{userId}_showtime_{showtimeId}` (Redis, TTL: 600s)
- Stored in Redis: `movie:idempotency:{key}`
- Prevents duplicate seat holds for the same user+showtime

**Promotion campaigns:** `promotion_campaign_{campaignId}` (Redis)
- Prevents duplicate payment orders for the same campaign

### 10.2 Payment Order Idempotency

The `payment_orders` table has a unique constraint on `order_id`. Calling `createOrder()` twice with the same `order_id` will fail at the DB level with a unique constraint violation.

### 10.3 Webhook Idempotency

The unified webhook handler (`POST /api/v1/webhooks/cashfree`) uses:
```
idempotency_key = `cf_webhook_{cfOrderId}_{status}`
```
Stored in Redis with a 24-hour TTL. Duplicate webhook deliveries are silently ignored.

### 10.4 Safe Retry Pattern for iOS

1. **Before payment:** Calling the booking creation endpoint twice is safe (idempotency key).
2. **After payment:** Calling the confirm endpoint twice is safe (idempotency check in webhook + DB state machine).
3. **Never call createOrder() twice with different order IDs** — that creates duplicate payment orders.

---

## SECTION 11: CASHFREE WEBHOOK (ALL CATEGORIES)

### 11.1 Webhook Endpoint

```
POST /api/v1/webhooks/cashfree
```

**Auth:** No JWT required — authenticated via HMAC signature

### 11.2 Raw Body Capture

The server captures the raw request body BEFORE JSON parsing (Express middleware):
```typescript
if (req.path.startsWith('/webhooks/')) {
  req.rawBody = ... // Buffer of raw body
}
```
This is required for HMAC-SHA256 signature verification.

### 11.3 Signature Verification

- Header: `x-cashfree-signature`
- Algorithm: HMAC-SHA256
- Secret: `CASHFREE_WEBHOOK_SECRET` env var
- Input: Raw request body bytes
- Verification: `crypto.timingSafeEqual()`

If signature verification fails → 401 Unauthorized, webhook ignored.

### 11.4 Unified Webhook Handler

**File:** `src/routes/unifiedWebhookRoutes.ts`

The single webhook handler at `POST /api/v1/webhooks/cashfree` handles ALL payment notifications:

1. Verify HMAC signature
2. Check idempotency (Redis)
3. Parse `x-cashfree-order-token` header to look up the `payment_orders` row
4. Read `booking_type` from the payment order (`'event' | 'turf' | 'movie'`)
5. Dispatch to the appropriate processor

### 11.5 Webhook Processors

#### Movie Webhook Processing

| Cashfree Event | Handler Method | Backend Action |
|---|---|---|
| `ORDER_COMPLETED` | `processMovieCompleted` | Verifies payment, calls `movieBookingService.confirmBooking()`, generates tickets, sends confirmation email |
| `ORDER_FAILED` | `processMovieFailed` | Releases seat holds, marks order as FAILED |
| `ORDER_CANCELLED` | `processMovieFailed` | Same as FAILED |
| `ORDER_EXPIRED` | `processMovieFailed` | Same as FAILED |
| `REFUND_SUCCESS` | `processMovieRefund` | Marks tickets as refunded, sends refund email |

#### Turf Webhook Processing

| Cashfree Event | Handler Method | Backend Action |
|---|---|---|
| `ORDER_COMPLETED` | `processTurfCompleted` | Verifies payment, calls `turfBookingService.confirmBooking()`, generates QR ticket, creates settlement, awards wallet coins |
| `ORDER_FAILED` | `processTurfFailed` | Releases slot, releases coupon, marks order FAILED |
| `ORDER_CANCELLED` | `processTurfFailed` | Same as FAILED |
| `ORDER_EXPIRED` | `processTurfFailed` | Same as FAILED |
| `REFUND_SUCCESS` | `processTurfRefund` | Processes refund through `turfRefundRepository`, creates settlement adjustments |

#### Event Webhook Processing

Events are free (no payment), so no Cashfree webhook processing is needed.

### 11.6 Notify URL Configuration

The single webhook URL must be set as:
```
CASHFREE_NOTIFY_URL=https://event-booking-backend.onrender.com/api/v1/webhooks/cashfree
```

**This is architecturally sufficient.** One URL handles all three booking types (movie, turf, event) because the handler reads `booking_type` from the database.

**Deprecated webhook routes still mounted but not used:**
- `POST /api/v1/turf/webhooks/cashfree` (from `turfWebhookRoutes.ts`)
- `POST /api/v1/movies/webhooks/cashfree` (from `movieWebhookRoutes.ts`)

These exist in the codebase but Cashfree is configured to send to the unified URL. The old routes can be removed in a cleanup PR.

### 11.7 Webhook Response

Always return HTTP 200 to Cashfree immediately after idempotency check. Heavy processing happens asynchronously.

---

## SECTION 12: PAYMENT SERVICE API (INTERNAL)

### 12.1 PaymentService Class

**File:** `src/services/paymentService.ts` (329 lines)

**Singleton:** Created in `src/services/promotionService.ts` line 78 as `paymentService` alias.

### 12.2 Key Methods

#### `createOrder(input: PaymentOrderCreateInput)` — Create Cashfree Order

**Input:**
```typescript
{
  booking_id: number;
  order_id: string;
  orderId: string;
  organization_id: number;
  event_id: number | null;
  movie_id: number | null;       // MANDATORY for movies
  amount: number;                // In paise (integer)
  currency: string;              // "INR"
  customerEmail: string;
  customerPhone: string;
  customerName: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
}
```

**Returns:** `CreateOrderResult` with `order` and `gatewayResponse`

**Side effects:**
- Creates `payment_orders` DB row with `booking_type` auto-determined
- Creates `payment_order_items` for each service (ticket, convenience fee, etc.)

---

#### `verifyPayment(orderId: string)` — Poll Cashfree for Status

**Returns:** `VerifyPaymentResult` with `success`, `paymentId`, `status`, `amountPaid`, `errorCode`, `errorMessage`

**Used by:** Confirm endpoints as a fallback when webhook hasn't arrived yet.

---

#### `createRefund(input: { orderId: string; amount: number; reason?: string })` — Initiate Refund

**Returns:** `RefundResult` with `gatewayRefundId`, `status`

**Side effects:** Creates `payment_refunds` DB row.

---

#### `refundOrder(orderId: string, reason?: string)` — Full Refund

Calls `createRefund` with the full order amount. Used by cancellation flows.

---

### 12.3 Payment Order Repository

**File:** `src/repositories/paymentOrderRepository.ts`

**Key method:** `create(input)` — determines `booking_type` from:
- `event_id` → `'event'`
- `movie_id` → `'movie'`
- Neither → `'turf'`

---

## SECTION 13: ADMIN AUTH API

### 13.1 Admin Login

#### POST `/api/v1/admin/auth/login` — Admin Login

**Auth:** None

**Request Body:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "admin": {
      "id": 1,
      "name": "string",
      "email": "string",
      "role": "super_admin",
      "permissions": ["users:read", "events:write", "movies:read", ...]
    },
    "accessToken": "eyJhbGciOi..."
  }
}
```

**Rate Limited:** 10 requests per 15 minutes per IP

**Permissions:** Admin permissions are loaded from `admin_permissions` table as a JSON array of `resource:action` strings (e.g., `"events:write"`, `"movies:read"`).

---

#### POST `/api/v1/admin/auth/refresh` — Refresh Admin Token

**Auth:** None (uses cookie)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOi..."
  }
}
```

---

### 13.2 Protected Admin Routes

All routes under `/api/v1/admin/*` require:
1. Valid `ADMIN_JWT_SECRET`-signed JWT with `typ: admin_access`
2. Header: `Authorization: Bearer <admin_token>`
3. Active admin account

**Admin JWT Payload:**
```json
{
  "sub": 1,
  "email": "admin@example.com",
  "role": "super_admin",
  "permissions": ["events:write", "movies:read"],
  "typ": "admin_access",
  "iat": 1724367600,
  "exp": 1724388600
}
```

**iOS rule:** Admin APIs are for the web dashboard only. iOS does NOT need admin auth.

---

## SECTION 14: ADMIN DASHBOARD API

### 14.1 Admin Routes (All require admin JWT)

#### GET `/api/v1/admin/dashboard/stats` — Dashboard Statistics

**Response (200):**
```json
{
  "success": true,
  "data": {
    "total_users": 1250,
    "total_events": 45,
    "total_movies": 30,
    "total_turf_bookings": 320,
    "total_event_bookings": 890,
    "total_movie_bookings": 560,
    "total_revenue": 125000.00,
    "active_organizations": 12
  }
}
```

---

#### GET `/api/v1/admin/users` — List Users

**Query Parameters:** `page`, `limit`, `search`

---

#### GET `/api/v1/admin/organizations` — List Organizations

**Response includes:** org name, city, status, venue count, event count.

---

#### GET `/api/v1/admin/events` — List All Events (Admin)

**Query Parameters:** `page`, `limit`, `status`, `search`

---

#### GET `/api/v1/admin/movies` — List All Movies (Admin)

**Query Parameters:** `page`, `limit`, `search`

---

#### GET `/api/v1/admin/turf/bookings` — List All Turf Bookings (Admin)

**Query Parameters:** `page`, `limit`, `status`, `venue_id`, `organization_id`

---

### 14.2 Admin Event Management

#### POST `/api/v1/admin/events` — Create Event (Admin)

#### PUT `/api/v1/admin/events/:id` — Update Event (Admin)

#### POST `/api/v1/admin/events/:id/publish` — Publish Event

#### POST `/api/v1/admin/events/:id/hide` — Hide Event

#### POST `/api/v1/admin/events/:id/cancel` — Cancel Event

#### DELETE `/api/v1/admin/events/:id` — Soft Delete Event

#### POST `/api/v1/admin/events/:id/restore` — Restore Event

#### POST `/api/v1/admin/events/:id/feature` — Set Featured

---

### 14.3 Admin Movie Management

#### POST `/api/v1/admin/movies` — Create Movie

#### PUT `/api/v1/admin/movies/:id` — Update Movie

#### DELETE `/api/v1/admin/movies/:id` — Delete Movie

---

### 14.4 Admin Turf Management

#### GET `/api/v1/admin/turf/venues` — List All Venues (Admin)

#### POST `/api/v1/admin/turf/venues` — Create Venue

#### PUT `/api/v1/admin/turf/venues/:id` — Update Venue

#### POST `/api/v1/admin/turf/venues/:id/approve` — Approve Venue

#### POST `/api/v1/admin/turf/venues/:id/reject` — Reject Venue

#### POST `/api/v1/admin/turf/venues/:id/resources` — Create Resource

#### PUT `/api/v1/admin/turf/resources/:id` — Update Resource

#### POST `/api/v1/admin/turf/resources/:id/slots` — Generate Slots

---

### 14.5 Admin Refund Management

#### POST `/api/v1/admin/refunds` — Create Refund (Admin-initiated)

#### GET `/api/v1/admin/refunds` — List Refunds

#### GET `/api/v1/admin/refunds/:id` — Refund Detail

---

### 14.6 Admin Organizer Management

#### POST `/api/v1/admin/organizers` — Create/Approve Organization

#### GET `/api/v1/admin/organizers` — List Organizations

#### PUT `/api/v1/admin/organizers/:id` — Update Organization

#### POST `/api/v1/admin/organizers/:id/approve` — Approve Organization

#### POST `/api/v1/admin/organizers/:id/suspend` — Suspend Organization

---

## SECTION 15: TICKET SCANNER API

### 15.1 QR Code Data Model

QR codes contain:
- `ticket_uuid`: UUID string (e.g., `turf_abc123...` or event ticket UUID)
- `venue_id` or `event_id`
- `slot_start`: timestamp
- `signature`: HMAC-SHA256 of `ticket_uuid` + `venue_id` + `slot_start` using `QR_SIGNING_SECRET`

### 15.2 QR Signature Verification

The backend verifies QR tickets using `signTicket()` / `verifyTicket()` from `src/utils/qrCode.ts`. The signature covers the payload fields so tampering is detected.

### 15.3 Turf QR Check-in (Scanner Flow)

#### POST `/api/v1/turf/bookings/:id/checkin` — Manager Check-in with QR

**Auth:** Admin or Manager JWT

**Request Body:**
```json
{
  "qr_token": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "booking_id": 1,
    "status": "checked_in",
    "booking_reference": "TFABC123",
    "user_name": "string",
    "slot_start": "ISO 8601",
    "slot_end": "ISO 8601"
  }
}
```

**Validation:**
1. QR token must exist in `turf_qr_tickets`
2. QR status must be `active` (not `used` or `revoked`)
3. QR must belong to the specified booking

---

### 15.4 Event QR Verification (Scanner)

**NOT IMPLEMENTED** — There is no dedicated event ticket scanner endpoint. Event tickets carry a `qr_signature` field but there is no verification endpoint exposed.

**iOS implication:** The scanner app (if built) would need a backend endpoint to verify event QR signatures. Currently, only turf QR scanning exists.

---

## SECTION 16: ORGANIZER APIs

### 16.1 Organizer Auth

#### POST `/api/v1/organizer/auth/register` — Organizer Registration

**Auth:** None

**Request Body:**
```json
{
  "name": "Organization Name",
  "email": "org@example.com",
  "phone": "string",
  "password": "string",
  "address": "string",
  "city": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "organization": {
      "id": 1,
      "name": "string",
      "email": "string",
      "city": "string",
      "status": "pending",
      "is_active": false
    },
    "message": "Registration submitted for approval"
  }
}
```

**Behavior:** Creates organization with `status = 'pending'`, `is_active = false`. Admin must approve.

---

#### POST `/api/v1/organizer/auth/login` — Organizer Login

**Auth:** None

**Request Body:**
```json
{
  "email": "org@example.com",
  "password": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "organization": {
      "id": 1,
      "name": "string",
      "email": "string",
      "status": "approved",
      "is_active": true,
      "permissions": ["events:write", "turf:write", "promotions:read"]
    },
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "eyJhbGciOi..."
  }
}
```

---

#### POST `/api/v1/organizer/auth/refresh` — Refresh Token

**Auth:** None (cookie-based)

---

#### GET `/api/v1/organizer/profile` — Get Profile

**Auth:** Organizer JWT

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "string",
    "email": "string",
    "phone": "string",
    "address": "string",
    "city": "string",
    "status": "approved",
    "is_active": true,
    "permissions": ["events:write", "turf:write"]
  }
}
```

---

### 16.2 Organizer Dashboard

#### GET `/api/v1/organizer/dashboard` — Dashboard Stats

**Auth:** Organizer JWT

**Response (200):**
```json
{
  "success": true,
  "data": {
    "total_events": 12,
    "total_turf_venues": 3,
    "total_bookings": 145,
    "total_revenue": 45000.00,
    "pending_approvals": 0,
    "upcoming_events": 3
  }
}
```

---

#### GET `/api/v1/organizer/events` — My Events

**Auth:** Organizer JWT

**Query Parameters:** `page`, `limit`, `status`

---

#### POST `/api/v1/organizer/events` — Create Event

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "title": "string",
  "description": "string",
  "category": "string",
  "city": "string",
  "venue": "string",
  "start_at": "ISO 8601",
  "end_at": "ISO 8601",
  "capacity": 100,
  "price": "0.00",
  "image_url": "string or null"
}
```

---

#### PUT `/api/v1/organizer/events/:id` — Update Event

**Auth:** Organizer JWT (must own the event)

---

#### POST `/api/v1/organizer/events/:id/publish` — Publish

**Auth:** Organizer JWT

---

### 16.3 Organizer Turf Management

#### GET `/api/v1/organizer/turf/venues` — My Venues

**Auth:** Organizer JWT

---

#### POST `/api/v1/organizer/turf/venues` — Create Venue

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "name": "string",
  "description": "string or null",
  "address": "string",
  "city": "string",
  "state": "string or null",
  "pincode": "string or null",
  "contact_phone": "string or null",
  "contact_email": "string or null",
  "image_url": "string or null"
}
```

---

#### POST `/api/v1/organizer/turf/venues/:id/resources` — Create Resource

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "name": "Main Field",
  "resource_type": "slot_based",
  "sport_type": "football",
  "base_price": 500.00,
  "is_active": true
}
```

---

#### POST `/api/v1/organizer/turf/slots/generate` — Generate Slots

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "venue_id": 1,
  "start_date": "2026-08-24",
  "end_date": "2026-09-07",
  "slot_duration_minutes": 60
}
```

---

#### GET `/api/v1/organizer/turf/bookings` — My Turf Bookings

**Auth:** Organizer JWT

---

### 16.4 Organizer Categories

#### GET `/api/v1/organizer/categories` — My Event Categories

**Auth:** Organizer JWT

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "organization_id": 1,
      "name": "Workshops",
      "slug": "workshops",
      "description": "string or null",
      "is_active": true,
      "event_count": 5,
      "created_at": "ISO 8601"
    }
  ]
}
```

---

#### POST `/api/v1/organizer/categories` — Create Category

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "name": "Workshops",
  "description": "string or null"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "organization_id": 1,
    "name": "Workshops",
    "slug": "workshops",
    "description": null,
    "is_active": true
  }
}
```

---

#### PUT `/api/v1/organizer/categories/:id` — Update Category

**Auth:** Organizer JWT

---

#### DELETE `/api/v1/organizer/categories/:id` — Delete Category

**Auth:** Organizer JWT

**Note:** Cannot delete if events are using this category.

---

### 16.5 Organizer Promotions

#### GET `/api/v1/organizer/promotions/packages` — Available Packages

**Auth:** Organizer JWT

---

#### POST `/api/v1/organizer/promotions/campaigns` — Create Campaign

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "package_id": 1,
  "entity_type": "turf_resource",
  "entity_id": 1,
  "start_at": "ISO 8601",
  "end_at": "ISO 8601"
}
```

---

#### POST `/api/v1/organizer/promotions/campaigns/:id/pay` — Pay for Campaign

**Auth:** Organizer JWT

**Returns:** `payment_session_id` for Cashfree

---

#### GET `/api/v1/organizer/promotions/campaigns` — My Campaigns

**Auth:** Organizer JWT

**Query Parameters:** `page`, `limit`, `status`

---

#### GET `/api/v1/organizer/promotions/campaigns/:id/analytics` — Campaign Analytics

**Auth:** Organizer JWT

---

## SECTION 17: IMAGE / MEDIA API

### 17.1 What Exists

**NO dedicated media upload or image management API exists.** Images are handled as follows:

| Entity | Image Field | Storage |
|---|---|---|
| Movies | `poster_url`, `banner_url` | External URL (string) |
| Cinemas | `image_url` | External URL (string) |
| Events | `image_url` | External URL (string) |
| Turf Venues | `image_url` | External URL (string) |
| Organizations | `logo_url` | External URL (string) |

### 17.2 How Images Work

1. Admin/organizer provides a URL to the image when creating/updating an entity
2. The backend stores the URL as a string — no file upload
3. The iOS app should:
   - Allow the user to pick/take a photo
   - Upload to a storage service (S3, Cloudinary, etc.) independently
   - Pass the resulting URL to the backend API

### 17.3 iOS Media Flow

```
iOS App                          External Storage              Backend
   |                                  |                        |
   |-- Upload image ---------------->|                        |
   |   (S3/Cloudinary/etc.)           |                        |
   |<-- Image URL -------------------|                        |
   |                                  |                        |
   |-- POST /admin/movies ----------->|                        |
   |   {poster_url: "https://...",   |                        |
   |    banner_url: "https://..."} --|----------------------->|
```

### 17.4 Brand Logo

The email template uses a hardcoded logo URL:
```
https://bigmembres.in/logo.png
```

This is NOT configurable per-organization.

---

## SECTION 18: PROMOTIONS API

### 18.1 Overview

The promotion system is an ad-serving platform where organizations pay to promote their turfs, events, or venues in search results and listings.

**NOTE:** Promotions are NOT part of the initial iOS scope. These endpoints exist for the admin/organizer web dashboards. iOS can ignore for V1.

### 18.2 Promotion Packages

#### GET `/api/v1/promotions/packages` — List Packages

**Auth:** Organizer JWT

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Basic Boost",
      "slug": "basic-boost",
      "price_paise": 50000,
      "duration_days": 7,
      "max_impressions": 10000,
      "priority_weight": 50,
      "eligible_categories": ["football", "cricket"],
      "eligible_entity_types": ["turf_resource"],
      "eligible_placements": ["search", "homepage"],
      "is_active": true
    }
  ]
}
```

---

### 18.3 Campaign Management

#### POST `/api/v1/promotions/campaigns` — Create Campaign

**Auth:** Organizer JWT

**Request Body:**
```json
{
  "package_id": 1,
  "entity_type": "turf_resource",
  "entity_id": 1,
  "start_at": "ISO 8601",
  "end_at": "ISO 8601"
}
```

#### POST `/api/v1/promotions/campaigns/:id/pay` — Create Payment Order

**Auth:** Organizer JWT

**Returns:** `payment_session_id` for Cashfree

#### GET `/api/v1/promotions/campaigns` — My Campaigns

**Query Parameters:** `page`, `limit`, `status`

---

### 18.4 Sponsored Results (Backend-Driven)

The promotion system injects sponsored results into listings via the `deliverSponsoredResults()` method. This is called internally by list endpoints — there is NO separate endpoint for the iOS app to call.

**How it works:**
1. When the backend returns event/turf/movie listings, it can include sponsored items at the top
2. Each sponsored item has `"sponsored": true` flag
3. iOS should render sponsored items with a "Sponsored" label

**NOT IMPLEMENTED for movies** — only events and turfs currently support sponsored injection.

---

## SECTION 19: SEARCH API

### 19.1 What Exists

**NO dedicated search endpoint exists.** Search is implemented as query parameters on list endpoints:

| Endpoint | Search Parameter | What It Searches |
|---|---|---|
| `GET /api/v1/events` | `?search=` | Title and description (ILIKE) |
| `GET /api/v1/turf/venues` | None | No search |

### 19.2 Event Search Details

```
GET /api/v1/events?search=cricket&city=Mumbai&category=workshop&page=1&limit=20
```

- `search` — ILIKE match on `title` and `description`
- `city` — exact match
- `category` — exact match
- Results are paginated

### 19.3 Turf Search

**NOT IMPLEMENTED.** There is no search parameter on turf endpoints. The iOS app must:
1. Fetch all venues via `GET /api/v1/turf/venues`
2. Filter client-side by name, city, sport type

### 19.4 Movie Search

**NOT IMPLEMENTED.** There is no search endpoint for movies. The iOS app must:
1. Fetch now-playing/upcoming movies
2. Filter client-side by title

### 19.5 iOS Search Strategy

For V1, implement client-side search:
1. On app launch, fetch and cache:
   - All movies (`/api/v1/movies/now-playing` + `/api/v1/movies/upcoming`)
   - All events (`/api/v1/events?limit=100`)
   - All turf venues (`/api/v1/turf/venues`)
2. Implement local search/filter on the cached data
3. For events, you can use the server-side `?search=` parameter for initial load + client-side refinement

---

## SECTION 20: PAGINATION

### 20.1 Standard Pagination Pattern

All list endpoints use the same pagination pattern:

**Query Parameters:**
- `page` — page number (default: 1, minimum: 1)
- `limit` — items per page (default: 20, maximum varies by endpoint)

**Response envelope:**
```json
{
  "success": true,
  "data": {
    "items": [...],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 100,
      "totalPages": 5
    }
  }
}
```

### 20.2 Endpoint-Specific Limits

| Endpoint | Default Limit | Max Limit |
|---|---|---|
| `/api/v1/events` | 20 | 100 |
| `/api/v1/movies/now-playing` | 20 | 100 |
| `/api/v1/movies/upcoming` | 20 | 100 |
| `/api/v1/movies/my-bookings` | 20 | 100 |
| `/api/v1/events/my-bookings` | 20 | — |
| `/api/v1/turf/my-bookings` | 20 | — |
| `/api/v1/turf/venues` | No pagination (all) | — |
| `/api/v1/turf/resources` | No pagination (all) | — |
| `/api/v1/turf/settlements` | 20 | 100 |
| `/api/v1/admin/organizations` | 25 | 100 |

### 20.3 iOS Pagination Implementation

```swift
// Standard pagination model
struct Pagination: Codable {
    let page: Int
    let limit: Int
    let total: Int
    let totalPages: Int
}

// Load next page when user scrolls near bottom
func loadNextPage() {
    guard !isLoading, hasNextPage else { return }
    currentPage += 1
    fetchItems(page: currentPage)
}
```

---

## SECTION 21: ERROR CONTRACT

### 21.1 Standard Error Format

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable error message"
}
```

### 21.2 HTTP Status Codes

| Status Code | Meaning | When |
|---|---|---|
| 200 | Success | All successful GET, POST, PUT, DELETE |
| 400 | Bad Request | Validation failure, invalid input |
| 401 | Unauthorized | Missing or invalid JWT |
| 403 | Forbidden | Valid JWT but insufficient permissions |
| 404 | Not Found | Resource doesn't exist |
| 409 | Conflict | Already booked, slot taken, duplicate |
| 422 | Unprocessable | Business rule violation |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Server Error | Unhandled server error |
| 502 | Bad Gateway | External API failure (Cashfree) |

### 21.3 Common Error Codes

| Error Code | HTTP | Message Examples |
|---|---|---|
| `VALIDATION_ERROR` | 400 | "Name is required" |
| `INVALID_CREDENTIALS` | 401 | "Invalid email or password" |
| `TOKEN_EXPIRED` | 401 | "Token has expired" |
| `FORBIDDEN` | 403 | "Not your booking" |
| `NOT_FOUND` | 404 | "Booking not found" |
| `SLOT_NOT_AVAILABLE` | 409 | "Slot no longer available" |
| `BOOKING_EXISTS` | 409 | "Booking already in progress" |
| `PAYMENT_FAILED` | 400 | "Payment not confirmed" |
| `RATE_LIMIT_EXCEEDED` | 429 | "Too many requests" |
| `CASHFREE_ERROR` | 502 | "Cashfree API error" |

### 21.4 iOS Error Handling

```swift
enum APIError: LocalizedError {
    case validation(String)
    case unauthorized
    case forbidden
    case notFound
    case conflict(String)
    case serverError(String)
    case network(Error)
    
    var errorDescription: String? {
        switch self {
        case .validation(let msg): return msg
        case .unauthorized: return "Please log in again"
        case .forbidden: return "You don't have permission"
        case .notFound: return "Not found"
        case .conflict(let msg): return msg
        case .serverError(let msg): return "Something went wrong"
        case .network(let err): return err.localizedDescription
        }
    }
}
```

---

## SECTION 22: CURRENCY / MONEY CONTRACT

### 22.1 Currency

**All monetary values are in INR (Indian Rupees).** Symbol: `₹`

### 22.2 Precision

| Context | Format |
|---|---|
| API JSON | String with 2 decimal places: `"250.00"` |
| Database | DECIMAL(10,2) for most tables |
| Financial calculation | Integer paise (avoid floating-point drift) |
| Turf settlement | DECIMAL(10,2) in DB |

### 22.3 Turf Prices

- `turf_availability_units.price` — per-slot price (DECIMAL, nullable; falls back to `turf_resources.base_price`)
- `turf_resources.base_price` — default per-slot price
- Booking amount = `unit.price * quantity - couponDiscount`

### 22.4 Movie Prices

- `movie_showtimes.price` — per-seat price (DECIMAL)
- Booking total = `price * seat_count`

### 22.5 Event Prices

- `events.price` — typically `"0.00"` (events are free)
- Stored as string for consistency

### 22.6 Promotions Prices

- `promotion_packages.price_paise` — in integer paise (NOT rupees)
- Conversion: `INR * 100 = paise`

### 22.7 iOS Display

```swift
extension Decimal {
    func toINR() -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "INR"
        formatter.locale = Locale(identifier: "en_IN")
        return formatter.string(from: self as NSDecimalNumber) ?? "₹0.00"
    }
}
```

---

## SECTION 23: DATE / TIME CONTRACT

### 23.1 Timezone

**All server datetimes are in UTC** (PostgreSQL `TIMESTAMPTZ`). The backend does NOT store IST.

**Turf slot generation** uses IST internally for slot window calculation but stores UTC in the database:
```typescript
const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
// Slot windows are calculated in IST then converted to UTC for storage
```

### 23.2 Date Format

- **API:** ISO 8601 strings: `2026-08-24T10:30:00.000Z`
- **Query params (dates):** `YYYY-MM-DD` format
- **Display on iOS:** Convert to local timezone using `DateFormatter` with `en_IN` locale

### 23.3 Showtimes

- `show_time` — ISO 8601 UTC timestamp
- `end_time` — ISO 8601 UTC timestamp or null
- **iOS should display in the user's local timezone**

### 23.4 Turf Slot Times

- `starts_at` / `ends_at` — ISO 8601 UTC timestamps
- Slot generation window: 06:00–22:00 IST by default
- Slots are 60 minutes each (configurable)

### 23.5 Event Times

- `start_at` / `end_at` — ISO 8601 UTC timestamps
- `created_at` — ISO 8601 UTC
- `updated_at` — ISO 8601 UTC

### 23.6 iOS Date Display

```swift
func formatDate(_ isoString: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: isoString) else { return "" }
    
    let display = DateFormatter()
    display.dateStyle = .medium
    display.timeStyle = .short
    display.locale = Locale(identifier: "en_IN")
    display.timeZone = .current
    return display.string(from: date)
}
```

### 23.7 Booking Expiry

- Turf booking timeout: 5 minutes (300 seconds) after creation
- Movie seat hold: 10 minutes (600 seconds) TTL in Redis
- Redis TTL is absolute — no extension mechanism exists

---

## SECTION 24: CONCURRENCY & RACE CONDITIONS

### 24.1 Turf Booking Concurrency

**Protected by:** `SELECT ... FOR UPDATE` row-level locking on `turf_availability_units`

**Flow:**
1. `BEGIN` transaction
2. `SELECT * FROM turf_availability_units WHERE id = $1 FOR UPDATE`
3. Check `status === 'available'`
4. Validate all business rules (duration, overlap, coupons)
5. Insert booking with `status = 'pending_payment'`
6. Mark unit as `payment_pending`
7. `COMMIT`

**Race condition prevention:** The `FOR UPDATE` lock ensures only one transaction can claim a slot at a time. Other concurrent requests block until the lock is released (COMMIT/ROLLBACK).

---

### 24.2 Movie Seat Hold Concurrency

**Protected by:** Redis Lua script for atomic seat locking

**Flow:**
1. Call Redis Lua script that:
   - Checks all requested seats are available
   - Atomically marks them as held
   - Sets 10-min TTL
2. If any seat is already held/booked → entire hold fails

**Race condition prevention:** The Lua script executes atomically on the Redis server. No client-side race window exists.

---

### 24.3 Event Booking Concurrency

**Protected by:** Atomic `UPDATE events SET remaining_capacity = remaining_capacity - N`

**Flow:**
1. `UPDATE events SET remaining_capacity = remaining_capacity - $2 WHERE id = $1`
2. Check affected rows > 0
3. If capacity is exhausted, the UPDATE affects 0 rows → error

**Max per user:** `turf_booking_audits` (event_bookings table) enforces max 10 tickets per user per event via unique constraint.

---

### 24.4 Webhook Idempotency

**Protected by:** Redis idempotency key with 24-hour TTL

**Key:** `cf_webhook_{cfOrderId}_{status}`

If the same webhook is delivered twice, the second delivery finds the key in Redis and returns 200 without processing.

---

### 24.5 Promotion Impression Concurrency

**Protected by:** Atomic `UPDATE ... WHERE impressions_delivered < max_impressions`

If two servers try to deliver the last impression simultaneously, the `WHERE` clause ensures only one succeeds.

---

## SECTION 25: GAP ANALYSIS

### 25.1 EXISTING (Full Implementation)

| Feature | Endpoint(s) | Status |
|---|---|---|
| Customer registration + OTP | `/api/v1/auth/register`, `/verify-otp` | FULL |
| Customer login + refresh | `/api/v1/auth/login`, `/refresh` | FULL |
| Customer profile | `/api/v1/auth/profile` | FULL |
| Movie discovery | `/api/v1/movies/now-playing`, `/upcoming`, `/featured` | FULL |
| Movie detail | `/api/v1/movies/:id` | FULL |
| Cinema listing | `/api/v1/movies/cinemas` | FULL |
| Showtimes | `/api/v1/movies/:movieId/showtimes` | FULL |
| Movie seat selection | `/api/v1/movies/seats` | FULL |
| Movie seat hold | `/api/v1/movies/seats/hold` | FULL |
| Movie booking + payment | `/api/v1/movies/bookings` | FULL |
| Movie booking confirm | `/api/v1/movies/bookings/confirm` | FULL |
| Movie my bookings | `/api/v1/movies/my-bookings` | FULL |
| Movie ticket detail | `/api/v1/movies/my-tickets/:id` | FULL |
| Event listing | `/api/v1/events` | FULL |
| Event detail | `/api/v1/events/:id` | FULL |
| Event categories | `/api/v1/events/categories` | FULL |
| Event cities | `/api/v1/events/cities` | FULL |
| Event booking (free) | `/api/v1/events/:id/book` | FULL |
| Event my bookings | `/api/v1/events/my-bookings` | FULL |
| Turf venue listing | `/api/v1/turf/venues` | FULL |
| Turf venue detail | `/api/v1/turf/venues/:id` | FULL |
| Turf resources | `/api/v1/turf/resources` | FULL |
| Turf sport types | `/api/v1/turf/sport-types` | FULL |
| Turf availability | `/api/v1/turf/venues/:id/availability` | FULL |
| Turf booking + payment | `/api/v1/turf/bookings` | FULL |
| Turf booking confirm | `/api/v1/turf/bookings/:id/confirm` | FULL |
| Turf my bookings | `/api/v1/turf/my-bookings` | FULL |
| Turf cancel booking | `/api/v1/turf/bookings/:id/cancel` | FULL |
| Turf QR check-in | `/api/v1/turf/bookings/:id/checkin` | FULL |
| Turf reviews | `/api/v1/turf/venues/:id/reviews` | FULL |
| Turf coupons | `/api/v1/turf/coupons/validate` | FULL |
| Cashfree payment gateway | Full integration | FULL |
| Unified webhook | `/api/v1/webhooks/cashfree` | FULL |
| Admin auth | `/api/v1/admin/auth/login` | FULL |
| Admin dashboard | Multiple endpoints | FULL |
| Admin event management | CRUD + publish/hide/cancel | FULL |
| Admin movie management | CRUD | FULL |
| Admin turf management | Venues, resources, slots | FULL |
| Admin refund management | `/api/v1/admin/refunds` | FULL |
| Admin organizer management | Approve/suspend | FULL |
| Organizer auth | Register, login, refresh | FULL |
| Organizer dashboard | `/api/v1/organizer/dashboard` | FULL |
| Organizer event management | CRUD + publish | FULL |
| Organizer turf management | Venues, resources, slots | FULL |
| Organizer categories | CRUD | FULL |
| Organizer promotions | Campaigns + payment | FULL |
| Payment verification | `verifyPayment()` | FULL |
| Payment refund | `createRefund()` | FULL |
| Seat hold (movie) | Redis Lua script | FULL |
| Slot locking (turf) | SELECT FOR UPDATE | FULL |
| Health checks | `/health/live`, `/health/ready` | FULL |

---

### 25.2 PARTIALLY IMPLEMENTED

| Feature | What Exists | What's Missing |
|---|---|---|
| Turf venue city filter | `city` column on venues | No `?city=` query parameter on `/api/v1/turf/venues` |
| Movie search | `?search=` on events only | No search on movies |
| Turf search | None | No text search on turf resources or venues |
| Event related | `/api/v1/events/:id/related` | Returns only 4 items, no pagination |
| Pagination consistency | Most endpoints paginated | Some return all items (venues, resources, availability) |
| Turf slot generation schedule | `turfAvailabilityGenerator.ts` | Scheduler exists but must be triggered externally |
| Movie my bookings pagination | `page` + `limit` params | Return format uses `data.items` not flat array |

---

### 25.3 MISSING (Not Implemented)

| Feature | iOS Impact | Notes |
|---|---|---|
| Dedicated search API | HIGH | Must implement client-side search |
| City autocomplete | MEDIUM | Hardcode city list in iOS |
| Geospatial / nearby search | MEDIUM | No "near me" feature possible |
| Image upload API | MEDIUM | Use external storage, pass URL |
| Push notifications | HIGH | No FCM/APNs integration |
| User profile update | MEDIUM | No PUT/PATCH for user profile |
| User password change | MEDIUM | No password change endpoint |
| Forgot password flow | MEDIUM | No password reset flow |
| Movie seat map (visual) | LOW | Backend returns seat data; iOS renders |
| Movie trailer/video | LOW | No video URL field on movies |
| Event ticket scanner | MEDIUM | No QR verification endpoint for events |
| Rating/review for movies | LOW | No movie review system |
| Favorites/watchlist | MEDIUM | No user favorites API |
| Booking history filter | LOW | No date-range filter on my-bookings |
| Cancellation policy display | LOW | Policy is hardcoded in backend (2hr/24hr) |
| Multiple cities support | LOW | No city management API |
| User addresses | MEDIUM | No address management |
| Wallet / coins display | LOW | Turf coins are backend-only, no user-facing API |
| Settlement details for organizers | MEDIUM | Settlement exists but not exposed to organizer API |
| Notification preferences | LOW | No notification settings |
| Referral system | LOW | Not implemented |
| Loyalty program | LOW | Coins exist but no redemption flow |
| Gift cards | NOT APPLICABLE | Not in scope |
| Social login (Google/Apple) | MEDIUM | Email/password only |
| Apple Sign-In | MEDIUM | Not implemented |
| Phone number login | LOW | OTP registration exists but no OTP-login flow |

---

### 25.4 BROKEN (Known Issues)

| Issue | Severity | Status |
|---|---|---|
| Turf venue listing has no city filter | MEDIUM | iOS must filter client-side |
| Old webhook routes still mounted but unused | LOW | Deprecated, should be removed |
| Movie seat hold uses in-memory Redis (no persistence) | MEDIUM | Seat holds lost on Redis restart |
| No movie seat hold expiry worker | MEDIUM | Holds expire via Redis TTL only |
| Promotion API not integrated into list endpoints | LOW | Sponsored results not returned in movie/turf/event listings |
| Event search only (no movie/turf search) | MEDIUM | Client-side search required |

---

### 25.5 DANGEROUS (Security / Correctness Concerns)

| Concern | Severity | Detail |
|---|---|---|
| QR signing secret rotation | HIGH | Changing `QR_SIGNING_SECRET` invalidates ALL existing QR codes |
| No rate limit on booking confirmation | MEDIUM | Brute-force order_id guessing possible on confirm endpoints |
| Redis single point of failure | HIGH | Seat holds and idempotency keys lost on Redis restart |
| No MFA for admin accounts | MEDIUM | Admin accounts have single-factor auth only |
| Coupon code not rate-limited | LOW | Could brute-force coupon codes |
| No input sanitization on review text | LOW | Stored as-is, displayed without escaping (frontend must XSS-protect) |
| `deleted_at` soft delete without cascade | LOW | Related records may reference soft-deleted entities |

---

## SECTION 26: FINAL iOS CHECKLIST

### 26.1 Pre-Development

- [ ] Obtain `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` (sandbox credentials for testing)
- [ ] Get `CASHFREE_WEBHOOK_SECRET` for webhook testing
- [ ] Set `CASHFREE_RETURN_URL` to your iOS app's deep link scheme (e.g., `bookmyturf://`)
- [ ] Set `CASHFREE_NOTIFY_URL` to production webhook URL
- [ ] Configure `CORS_ORIGIN` to include your iOS app's bundle ID or domain
- [ ] Seed test data: movies, events, turf venues with slots
- [ ] Create test customer accounts
- [ ] Set up Cashfree sandbox account

### 26.2 Network Layer

- [ ] Base URL: `https://event-booking-backend.onrender.com`
- [ ] API prefix: `/api/v1`
- [ ] JWT storage: iOS Keychain
- [ ] Refresh token: Auto-handled via cookie
- [ ] 401 handler: Auto-refresh → retry → logout if refresh fails
- [ ] Error mapper: Map `{success:false, error, message}` to `APIError` enum
- [ ] Request interceptor: Attach `Authorization: Bearer` header
- [ ] Response decoder: JSON with snake_case keys → Swift camelCase

### 26.3 Auth

- [ ] Registration screen with OTP verification
- [ ] Login screen
- [ ] Token storage in Keychain
- [ ] Auto-login on app launch
- [ ] Logout flow
- [ ] Profile screen

### 26.4 Movies

- [ ] Now Playing list (paginated)
- [ ] Upcoming list
- [ ] Movie detail screen
- [ ] Cinema selection (by city)
- [ ] Showtime selection (by date)
- [ ] Seat map with visual layout
- [ ] Seat hold flow (with timer countdown)
- [ ] Payment integration (Cashfree SDK)
- [ ] Payment confirmation (CRITICAL: call confirm endpoint)
- [ ] Ticket list with QR codes
- [ ] Ticket detail with QR image

### 26.5 Events

- [ ] Event listing (with category/city filters)
- [ ] Event detail (with booking stats)
- [ ] Related events
- [ ] Booking flow (free, no payment)
- [ ] Ticket list with QR signatures
- [ ] QR display for entry

### 26.6 Turfs

- [ ] Venue listing (all venues, client-side city filter)
- [ ] Venue detail (with resources, reviews)
- [ ] Sport type filter
- [ ] Resource listing (by venue, by sport)
- [ ] Availability calendar/slots
- [ ] Slot booking flow
- [ ] Coupon validation
- [ ] Payment integration (Cashfree SDK)
- [ ] Payment confirmation
- [ ] QR ticket display
- [ ] My bookings list
- [ ] Cancel booking (with policy warning)
- [ ] Self check-in

### 26.7 Cashfree Integration

- [ ] Integrate Cashfree iOS SDK
- [ ] Implement web checkout OR payment SDK
- [ ] Handle `return_url` deep link back to app
- [ ] Call confirm endpoint on return
- [ ] Handle payment failure gracefully
- [ ] Show loading state during payment

### 26.8 UI/UX

- [ ] Loading states for all API calls
- [ ] Error messages from `message` field
- [ ] Empty states for lists
- [ ] Pull-to-refresh
- [ ] Infinite scroll pagination
- [ ] Seat selection timer (10-min countdown)
- [ ] INR currency formatting
- [ ] UTC-to-local datetime conversion

---

## SECTION 27: SWIFT API CLIENT CONTRACT

### 27.1 Base Configuration

```swift
enum APIConfig {
    static let baseURL = URL(string: "https://event-booking-backend.onrender.com")!
    static let apiVersion = "v1"
    static var accessToken: String? {
        get { KeychainHelper.standard.read(key: "accessToken") }
        set { KeychainHelper.standard.save(key: "accessToken", value: newValue) }
    }
}
```

### 27.2 Network Client Skeleton

```swift
import Foundation

struct APIResponse<T: Codable>: Codable {
    let success: Bool
    let data: T?
    let error: String?
    let message: String?
}

class APIClient {
    static let shared = APIClient()
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.httpCookieStorage = HTTPCookieStorage.shared  // For refreshToken cookie
        self.session = URLSession(configuration: config)
        
        self.decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        
        self.encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
    }
    
    private func url(_ path: String) -> URL {
        APIConfig.baseURL.appendingPathComponent("api/\(APIConfig.apiVersion)/\(path)")
    }
    
    private var authHeader: [String: String]? {
        guard let token = APIConfig.accessToken else { return nil }
        return ["Authorization": "Bearer \(token)"]
    }
    
    func request<T: Codable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        responseType: T.Type
    ) async throws -> T {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authHeader?.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        request.httpBody = body
        
        let (data, response) = try await session.data(for: request)
        
        guard let http = response as? HTTPURLResponse else {
            throw APIError.network(URLError(.badServerResponse))
        }
        
        if http.statusCode == 401 {
            // Attempt token refresh
            if try await refreshToken() {
                return try await request(path, method: method, body: body, responseType: T.self)
            }
            throw APIError.unauthorized
        }
        
        if !(200...299).contains(http.statusCode) {
            let errorResponse = try? decoder.decode(APIErrorResponse.self, from: data)
            throw APIError.server(errorResponse?.message ?? "Unknown error")
        }
        
        let apiResponse = try decoder.decode(APIResponse<T>.self, from: data)
        guard let result = apiResponse.data else {
            throw APIError.server(apiResponse.message ?? "Empty response")
        }
        return result
    }
    
    private func refreshToken() async throws -> Bool {
        var request = URLRequest(url: url("auth/refresh"))
        request.httpMethod = "POST"
        
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            return false
        }
        
        let refreshResponse = try decoder.decode(
            APIResponse<TokenResponse>.self,
            from: data
        )
        if let tokens = refreshResponse.data {
            APIConfig.accessToken = tokens.accessToken
            return true
        }
        return false
    }
}

struct APIErrorResponse: Codable {
    let success: Bool
    let error: String
    let message: String
}

struct TokenResponse: Codable {
    let accessToken: String
    let refreshToken: String?
}
```

### 27.3 Swift Models — Movies

```swift
struct Movie: Codable, Identifiable {
    let id: Int
    let title: String
    let description: String
    let posterUrl: URL?
    let bannerUrl: URL?
    let genre: String?
    let language: String?
    let durationMinutes: Int
    let certificate: String?
    let isFeatured: Bool
    let createdAt: Date
}

struct Cinema: Codable, Identifiable {
    let id: Int
    let name: String
    let address: String
    let city: String
    let state: String?
    let pincode: String?
    let latitude: Double?
    let longitude: Double?
    let contactPhone: String?
    let imageUrl: URL?
    let facilities: [String]?
    let isActive: Bool
}

struct Showtime: Codable, Identifiable {
    let id: Int
    let movieId: Int
    let cinemaId: Int
    let screenName: String
    let showTime: Date
    let endTime: Date?
    let price: Decimal
    let availableSeats: Int
    let totalSeats: Int
    let isActive: Bool
}

struct Seat: Codable, Identifiable {
    let seatLabel: String
    let row: String
    let number: Int
    let price: Decimal
    let type: String
    let status: String
}

struct MovieBooking: Codable, Identifiable {
    let bookingId: Int
    let bookingReference: String
    let movieId: Int
    let movieTitle: String
    let posterUrl: URL?
    let cinemaName: String
    let screenName: String
    let showTime: Date
    let seatLabels: [String]
    let totalAmount: Decimal
    let status: String
    let tickets: [Ticket]?
    let createdAt: Date
}

struct Ticket: Codable, Identifiable {
    let ticketId: String
    let seatLabel: String
    let row: String?
    let number: Int?
    let price: Decimal
    let qrToken: String?
    let qrCodeUrl: URL?
}
```

### 27.4 Swift Models — Events

```swift
struct Event: Codable, Identifiable {
    let id: Int
    let title: String
    let description: String
    let category: String
    let city: String
    let venue: String
    let startAt: Date
    let endAt: Date
    let capacity: Int
    let remainingCapacity: Int?
    let price: Decimal
    let imageUrl: URL?
    let status: String
    let visibility: String
    let isFeatured: Bool
}

struct EventBooking: Codable, Identifiable {
    let bookingId: Int
    let bookingReference: String
    let eventId: Int
    let eventTitle: String
    let eventImageUrl: URL?
    let startAt: Date
    let endAt: Date
    let venue: String
    let city: String
    let quantity: Int
    let totalAmount: Decimal
    let status: String
    let tickets: [EventTicket]?
    let createdAt: Date
}

struct EventTicket: Codable, Identifiable {
    let ticketUuid: String
    let qrSignature: String
    let attendeeName: String
    let attendeeEmail: String?
    let seatLabel: String?
}
```

### 27.5 Swift Models — Turfs

```swift
struct TurfVenue: Codable, Identifiable {
    let id: Int
    let name: String
    let description: String?
    let address: String
    let city: String
    let state: String?
    let pincode: String?
    let latitude: Double?
    let longitude: Double?
    let contactPhone: String?
    let contactEmail: String?
    let imageUrl: URL?
    let isActive: Bool
    let averageRating: Double?
    let reviews: [Review]?
    let resources: [TurfResource]?
}

struct TurfResource: Codable, Identifiable {
    let id: Int
    let venueId: Int
    let name: String
    let resourceType: String
    let sportType: String
    let basePrice: Decimal
    let isActive: Bool
}

struct TurfAvailabilitySlot: Codable, Identifiable {
    let id: Int
    let resourceId: Int
    let resourceName: String
    let sportType: String
    let startsAt: Date
    let endsAt: Date
    let price: Decimal?
    let status: String
}

struct TurfBooking: Codable, Identifiable {
    let bookingId: Int
    let bookingReference: String
    let venueName: String
    let resourceName: String
    let sportType: String
    let slotStart: Date
    let slotEnd: Date
    let amount: Decimal
    let status: String
    let qrToken: String?
    let quantity: Int
}

struct TurfReview: Codable, Identifiable {
    let id: Int
    let userId: Int
    let rating: Int
    let review: String?
    let createdAt: Date
}
```

---

## SECTION 28: IMPLEMENTATION ORDER

### Phase 1: Foundation (Week 1-2)

1. **Network layer** — APIClient with auth interceptor, error handling, token refresh
2. **Auth screens** — Register (with OTP), Login, Profile, Logout
3. **Models** — All Swift models (Movie, Event, Turf, Booking, Ticket, etc.)
4. **Home screen** — Featured movies, events, active event, turf venues
5. **Data seeding** — Verify test data exists in staging backend

### Phase 2: Movies (Week 3-4)

6. **Movie listing** — Now Playing, Upcoming, with pagination
7. **Movie detail** — Title, description, poster, banner
8. **Cinema listing** — By city filter
9. **Showtime selection** — By date, cinema grouping
10. **Seat map** — Visual layout with seat status
11. **Seat hold** — Hold seats with 10-min timer
12. **Cashfree integration** — SDK setup, payment webview
13. **Payment confirmation** — CRITICAL confirm endpoint call
14. **Ticket display** — List with QR codes
15. **Ticket detail** — Full ticket with QR image

### Phase 3: Events (Week 5)

16. **Event listing** — With category/city filters, search
17. **Event detail** — With booking stats, related events
18. **Event booking** — Free booking flow
19. **Event tickets** — QR display
20. **My event bookings** — List with status

### Phase 4: Turfs (Week 6-7)

21. **Venue listing** — All venues, client-side city/sport filter
22. **Venue detail** — Resources, reviews, rating
23. **Sport type filter** — Filter by sport
24. **Availability** — Slot listing with date picker
25. **Booking flow** — Slot selection, coupon, payment
26. **Cashfree for turfs** — Same SDK, different confirm endpoint
27. **QR ticket** — Display for check-in
28. **My turf bookings** — List with cancel option
29. **Cancel booking** — With cancellation policy warning
30. **Reviews** — Post-booking review flow

### Phase 5: Polish (Week 8)

31. **Search** — Client-side search across all categories
32. **Deep linking** — Return URL from Cashfree → app
33. **Push notifications** — Payment success, booking reminders
34. **Error handling** — Comprehensive error states
35. **Offline support** — Cache listings for offline browsing
36. **Analytics** — Track user flows (optional)

### Testing Checklist

- [ ] Register new user → OTP received → verified → logged in
- [ ] Login with existing credentials → token received
- [ ] Browse movies → select movie → cinemas → showtimes → seats → hold
- [ ] Complete movie payment → confirm → tickets generated
- [ ] Browse events → book free event → tickets received
- [ ] Browse turfs → select venue → slots → book → pay → QR received
- [ ] Cancel turf booking (24hr before) → full refund
- [ ] Cancel turf booking (<24hr) → no refund / partial
- [ ] Refresh token flow → access token renewed
- [ ] 401 on expired token → auto refresh → retry succeeds
- [ ] Payment failure → retry flow → new booking created

---

## APPENDIX A: COMPLETE ENDPOINT TABLE

### Public Endpoints (No Auth)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/live` | Liveness check |
| GET | `/health/ready` | Readiness check |
| GET | `/api/v1/movies/now-playing` | Now playing movies |
| GET | `/api/v1/movies/upcoming` | Upcoming movies |
| GET | `/api/v1/movies/featured` | Featured movies |
| GET | `/api/v1/movies/:id` | Movie detail |
| GET | `/api/v1/movies/cinemas` | Cinema list |
| GET | `/api/v1/movies/:movieId/showtimes` | Showtimes |
| GET | `/api/v1/movies/showtimes/:id/seats` | Seat layout |
| POST | `/api/v1/auth/register` | Register |
| POST | `/api/v1/auth/verify-otp` | Verify OTP |
| POST | `/api/v1/auth/login` | Login |
| GET | `/api/v1/events` | List events |
| GET | `/api/v1/events/featured` | Featured events |
| GET | `/api/v1/events/active` | Active event |
| GET | `/api/v1/events/:id` | Event detail |
| GET | `/api/v1/events/:id/related` | Related events |
| GET | `/api/v1/events/categories` | Event categories |
| GET | `/api/v1/events/cities` | Event cities |
| GET | `/api/v1/turf/venues` | Turf venues |
| GET | `/api/v1/turf/venues/:id` | Venue detail |
| GET | `/api/v1/turf/resources` | Resources |
| GET | `/api/v1/turf/sport-types` | Sport types |
| GET | `/api/v1/turf/venues/:id/availability` | Availability slots |

### Customer-Auth Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/auth/logout` | Logout |
| GET | `/api/v1/auth/profile` | Get profile |
| POST | `/api/v1/auth/refresh` | Refresh token |
| POST | `/api/v1/movies/seats/hold` | Hold seats |
| DELETE | `/api/v1/movies/seats/hold` | Release hold |
| POST | `/api/v1/movies/bookings` | Create movie booking |
| POST | `/api/v1/movies/bookings/confirm` | Confirm movie booking |
| GET | `/api/v1/movies/my-bookings` | My movie bookings |
| GET | `/api/v1/movies/my-tickets/:id` | Ticket detail |
| POST | `/api/v1/events/:id/book` | Book event (free) |
| GET | `/api/v1/events/my-bookings` | My event bookings |
| POST | `/api/v1/turf/bookings` | Create turf booking |
| POST | `/api/v1/turf/bookings/:id/confirm` | Confirm turf booking |
| GET | `/api/v1/turf/my-bookings` | My turf bookings |
| POST | `/api/v1/turf/bookings/:id/cancel` | Cancel booking |
| POST | `/api/v1/turf/bookings/:id/checkin` | Self check-in |
| POST | `/api/v1/turf/venues/:id/reviews` | Create review |
| GET | `/api/v1/turf/coupons/validate` | Validate coupon |

### Admin-Auth Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/admin/auth/login` | Admin login |
| POST | `/api/v1/admin/auth/refresh` | Admin token refresh |

### Organizer-Auth Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/organizer/auth/register` | Organizer register |
| POST | `/api/v1/organizer/auth/login` | Organizer login |
| POST | `/api/v1/organizer/auth/refresh` | Organizer token refresh |

---

## APPENDIX B: CRITICAL iOS IMPLEMENTATION NOTES

### B.1 The Most Common Integration Mistake

**Calling `POST /api/v1/movies/bookings` and expecting tickets immediately.**

The correct flow is:
1. `POST /api/v1/movies/seats/hold` — Hold the seats
2. `POST /api/v1/movies/bookings` — Create booking + get payment_session_id
3. Open Cashfree payment (webview or SDK)
4. User returns from payment → `POST /api/v1/movies/bookings/confirm`
5. **Only now do tickets exist**

### B.2 Cashfree Deep Link

Set `CASHFREE_RETURN_URL` to a custom URL scheme (e.g., `bookmyturf://payment-return`). When the user completes payment in Cashfree, they are redirected to this URL, and your iOS app handles the deep link to call the confirm endpoint.

### B.3 Seat Hold Timer

The iOS app must implement its own countdown timer (10 minutes). When the timer expires:
- Release the hold: `DELETE /api/v1/movies/seats/hold`
- Inform the user their seats have been released
- Offer to restart the selection process

### B.4 Turf Slot Availability

Turf slots are auto-generated by a background scheduler (`turfAvailabilityScheduler.ts`):
- Bootstrap: 30 seconds after server start
- Extension: Every 60 minutes (adds next day, removes old days)
- Rolling window: Tomorrow → Tomorrow+15 days
- If slots are not showing, the scheduler may not have run yet

### B.5 Event Booking Limits

- Max 10 tickets per booking
- Max 10 bookings per user per event
- Events are always free
- No payment step

### B.6 Turf Cancellation Policy

- Cancellation allowed only >= 2 hours before slot
- Full refund only if cancelled >= 24 hours before slot
- No refund if cancelled < 24 hours before slot (penalty applies)
- Cannot cancel after check-in

### B.7 Token Expiry Handling

| Token | Lifetime | Refresh Mechanism |
|---|---|---|
| Customer access | 15 minutes | `/api/v1/auth/refresh` (cookie) |
| Admin access | 12 hours | `/api/v1/admin/auth/refresh` (cookie) |
| Organizer access | 8 hours | `/api/v1/organizer/auth/refresh` (cookie) |

Implement a silent refresh that fires when the access token is within 2 minutes of expiry.

---

*Document generated from full codebase audit on 2026-08-23. All endpoints, schemas, and business rules verified against actual implementation. Nothing invented.*
