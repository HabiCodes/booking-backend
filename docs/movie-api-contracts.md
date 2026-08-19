# Movie Domain — API Contracts

> **Audience**: Frontend / mobile / integration teams  
> **Base URL**: `https://api.yourdomain.com`  
> **Versioned prefix**: `/api/v1` (also mounted at legacy `/api`)  
> **All monetary amounts**: integer paise (1 INR = 100 paise). Never float.  
> **All dates**: ISO-8601 strings. Showtime datetimes are `TIMESTAMPTZ` stored in IST (Asia/Kolkata).  
> **Standard response envelope**: `{ success: boolean, data?: any, message?: string, pagination?: {...} }`  
> **Error envelope**: `{ success: false, message: string, errors?: object }`

---

## Table of Contents

1. [Authentication & Authorization](#1-authentication--authorization)
2. [Public Movie Discovery](#2-public-movie-discovery)
3. [Cinema & Screen Discovery](#3-cinema--screen-discovery)
4. [Showtimes](#4-showtimes)
5. [Seat Layout & Pricing](#5-seat-layout--pricing)
6. [Authenticated Booking Flow](#6-authenticated-booking-flow)
7. [Organizer Movie Management](#7-organizer-movie-management)
8. [Organizer Offline (Counter) Bookings](#8-organizer-offline-counter-bookings)
9. [Admin Movie Management](#9-admin-movie-management)
10. [Movie Scanner (Ticket Verification)](#10-movie-scanner-ticket-verification)
11. [Owner Analytics — Movies](#11-owner-analytics--movies)
12. [Movie Payment Webhooks](#12-movie-payment-webhooks)
13. [Error Codes & Conventions](#13-error-codes--conventions)

---

## 1. Authentication & Authorization

### Token Types

| Token | Header | Expiry | Used By |
|-------|--------|--------|---------|
| `access` | `Authorization: Bearer <token>` | 15 min | Customer booking flow |
| `refresh` | Body field `refreshToken` | 30 days | Token renewal |
| `admin_access` | `Authorization: Bearer <token>` | 12 hours | Admin panel |
| `organizer_access` | `Authorization: Bearer <token>` | 8 hours | Organizer/manager panel |

### Role Hierarchy

| Role | Scope |
|------|-------|
| `super_admin` | All admin permissions |
| `admin` | All admin permissions except role management |
| `event_manager` | Events only (legacy) |
| `ticket_scanner` | Ticket verify + check-in only |
| `organizer_owner` | Full org access (movies, cinemas, screens, showtimes, price caps, offline bookings, layout versions) |
| `organizer_manager` | Granular — needs explicit `organizer:*` permissions per resource |

### Permission Tokens (Organizer)

Movies: `organizer:movies:read`, `organizer:movies:write`, `organizer:movies:publish`, `organizer:movies:delete`  
Cinemas: `organizer:cinemas:read`, `organizer:cinemas:write`, `organizer:cinemas:delete`  
Screens: `organizer:screens:read`, `organizer:screens:write`, `organizer:screens:delete`  
Showtimes: `organizer:showtimes:read`, `organizer:showtimes:write`, `organizer:showtimes:delete`  
Price Caps: `organizer:price_caps:read`, `organizer:price_caps:write`, `organizer:price_caps:delete`  
Bookings: `organizer:bookings:read`, `organizer:bookings:write`, `organizer:bookings:delete`  
Scanner: `scanner:verify`, `scanner:checkin`

---

## 2. Public Movie Discovery

### 2.1 List Movies

```
GET /api/v1/movies
```

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `city` | string | no | Filter by city (case-insensitive) |
| `genre` | string | no | Filter by genre |
| `language` | string | no | Filter by language |
| `status` | string | no | Filter by status: `now_showing`, `coming_soon`, `hidden` |
| `featured` | boolean | no | `true` for featured only |
| `q` | string | no | Full-text search in title/description |
| `page` | number | no | Default 1 |
| `pageSize` | number | no | Default 25, max 100 |
| `sortBy` | string | no | `created_at`, `release_date`, `title` |
| `sortOrder` | string | no | `ASC` or `DESC` |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "KGF Chapter 2",
      "slug": "kgf-chapter-2",
      "description": "...",
      "genre": "Action",
      "language": "Tamil",
      "durationMinutes": 165,
      "rating": "U/A",
      "posterUrl": "https://...",
      "bannerUrl": "https://...",
      "trailerUrl": "https://...",
      "releaseDate": "2024-04-14",
      "status": "now_showing",
      "isFeatured": false,
      "isActive": true,
      "cinemaCount": 3,
      "organizationId": 1,
      "createdAt": "2024-01-15T10:00:00Z",
      "updatedAt": "2024-01-15T10:00:00Z"
    }
  ],
  "pagination": {
    "total": 42,
    "page": 1,
    "pageSize": 25,
    "totalPages": 2
  }
}
```

---

### 2.2 Get Movie

```
GET /api/v1/movies/:slugOrId
```

**Path Params**

| Param | Description |
|-------|-------------|
| `slugOrId` | Numeric ID or URL slug |

**Response 200**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "title": "KGF Chapter 2",
    "slug": "kgf-chapter-2",
    "description": "...",
    "genre": "Action",
    "language": "Tamil",
    "durationMinutes": 165,
    "rating": "U/A",
    "posterUrl": "https://...",
    "bannerUrl": "https://...",
    "trailerUrl": "https://...",
    "releaseDate": "2024-04-14",
    "status": "now_showing",
    "isFeatured": false,
    "isActive": true,
    "organizationId": 1,
    "cinemas": [
      {
        "cinemaId": 5,
        "cinemaName": "PVR Chennai",
        "city": "Chennai",
        "screenName": "Screen 1",
        "showtimeCount": 12
      }
    ],
    "createdAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T10:00:00Z"
  }
}
```

**Errors**: `404` — Movie not found or inactive

---

### 2.3 Featured Movies

```
GET /api/v1/movies/featured
```

**Response 200**

```json
{
  "success": true,
  "data": [
    { "id": 1, "title": "...", "posterUrl": "...", "genre": "...", "language": "..." }
  ]
}
```

---

### 2.4 Genres

```
GET /api/v1/movies/genres
```

**Response 200**

```json
{ "success": true, "data": ["Action", "Comedy", "Drama", "Thriller"] }
```

---

### 2.5 Languages

```
GET /api/v1/movies/languages
```

**Response 200**

```json
{ "success": true, "data": ["Tamil", "Hindi", "English", "Telugu", "Malayalam"] }
```

---

## 3. Cinema & Screen Discovery

### 3.1 List Cinemas

```
GET /api/v1/cinemas
```

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `city` | string | no | Filter by city |
| `q` | string | no | Search name/address |
| `page` | number | no | Default 1 |
| `pageSize` | number | no | Default 25, max 100 |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "name": "PVR Chennai",
      "slug": "pvr-chennai",
      "address": "123 T Nagar",
      "city": "Chennai",
      "state": "Tamil Nadu",
      "latitude": 13.0418,
      "longitude": 80.2341,
      "phone": "+91-44-12345678",
      "screenCount": 4,
      "totalSeatCapacity": 320,
      "facilities": ["parking", "food", "wheelchair"],
      "isActive": true,
      "organizationId": 1,
      "createdAt": "2024-01-10T08:00:00Z"
    }
  ],
  "pagination": { "total": 15, "page": 1, "pageSize": 25, "totalPages": 1 }
}
```

---

### 3.2 Get Cinema

```
GET /api/v1/cinemas/:idOrSlug
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "id": 5,
    "name": "PVR Chennai",
    "slug": "pvr-chennai",
    "address": "123 T Nagar",
    "city": "Chennai",
    "state": "Tamil Nadu",
    "latitude": 13.0418,
    "longitude": 80.2341,
    "phone": "+91-44-12345678",
    "screenCount": 4,
    "totalSeatCapacity": 320,
    "facilities": ["parking", "food", "wheelchair"],
    "isActive": true,
    "screens": [
      {
        "id": 12,
        "screenNumber": 1,
        "name": "Main Hall",
        "screenType": "imax",
        "soundSystem": "Dolby Atmos",
        "seatCapacity": 80,
        "rowLabels": ["A", "B", "C", "D", "E", "F", "G", "H"],
        "seatsPerRow": [10, 10, 10, 10, 10, 10, 10, 10]
      }
    ]
  }
}
```

---

### 3.3 Get Screens for Cinema

```
GET /api/v1/cinemas/:cinemaId/screens
```

**Response 200** — array of `CinemaScreenPublic` (see types: `id`, `screenNumber`, `name`, `screenType`, `soundSystem`, `seatCapacity`, `rowLabels`, `seatsPerRow`, `seatStartNumber`, `seatTypes`, `pricingRules`)

---

## 4. Showtimes

### 4.1 List Showtimes

```
GET /api/v1/showtimes
```

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `movieId` | number | no | Filter by movie |
| `cinemaId` | number | no | Filter by cinema |
| `city` | string | no | Filter by city |
| `date` | string (YYYY-MM-DD) | no | Filter by show date (IST) |
| `from` | string (ISO) | no | Filter from datetime |
| `to` | string (ISO) | no | Filter to datetime |
| `status` | string | no | `on_sale`, `sold_out`, `cancelled`, `ended` |
| `language` | string | no | Filter by language |
| `format` | string | no | `2d`, `3d`, `imax`, `imax_3d` |
| `page` | number | no | Default 1 |
| `pageSize` | number | no | Default 25, max 100 |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 101,
      "movieId": 1,
      "movieTitle": "KGF Chapter 2",
      "moviePosterUrl": "https://...",
      "cinemaId": 5,
      "cinemaName": "PVR Chennai",
      "cinemaCity": "Chennai",
      "screenId": 12,
      "screenName": "Main Hall",
      "organizationId": 1,
      "showDatetime": "2024-04-14T14:00:00+05:30",
      "endDatetime": "2024-04-14T16:45:00+05:30",
      "language": "Tamil",
      "format": "imax",
      "price": 35000,
      "currency": "INR",
      "totalSeats": 80,
      "availableSeats": 23,
      "bookedSeats": 57,
      "status": "on_sale",
      "isHidden": false,
      "createdAt": "2024-01-15T10:00:00Z",
      "updatedAt": "2024-04-14T12:00:00Z"
    }
  ],
  "pagination": { "total": 12, "page": 1, "pageSize": 25, "totalPages": 1 }
}
```

**Note**: `price` is base price in paise. Final price per seat may differ due to seat type multiplier and price caps (see Seat Pricing).

---

### 4.2 Get Showtime

```
GET /api/v1/showtimes/:idOrSlug
```

**Response 200** — same shape as a single showtime object above.

**Errors**: `404` — Showtime not found or hidden

---

### 4.3 Cities with Movies

```
GET /api/v1/showtimes/cities
```

**Query Params**: same as list showtimes (filters apply)

**Response 200**

```json
{ "success": true, "data": ["Chennai", "Bangalore", "Mumbai", "Delhi"] }
```

---

## 5. Seat Layout & Pricing

### 5.1 Seat Layout for Showtime

```
GET /api/v1/showtimes/:showtimeId/seats
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "showtimeId": 101,
    "screenId": 12,
    "price": 35000,
    "currency": "INR",
    "rows": [
      {
        "rowLabel": "A",
        "seatType": "standard",
        "seats": [
          { "seatId": 1, "seatNumber": 1, "status": "available", "pricePaise": 35000 },
          { "seatId": 2, "seatNumber": 2, "status": "booked", "pricePaise": 35000 },
          { "seatId": 3, "seatNumber": 3, "status": "held", "pricePaise": 35000, "holdExpiresAt": "2024-04-14T13:50:00Z" }
        ]
      },
      {
        "rowLabel": "B",
        "seatType": "premium",
        "seats": [
          { "seatId": 11, "seatNumber": 1, "status": "available", "pricePaise": 45500 },
          { "seatId": 12, "seatNumber": 2, "status": "available", "pricePaise": 45500 }
        ]
      }
    ]
  }
}
```

**Seat statuses**: `available`, `held` (in Redis hold, expires), `booked` (confirmed booking)

**Seat types**: `standard` (1.0x), `premium` (1.3x), `sofa` (1.6x), `couple` (1.5x), `wheelchair` (1.0x). Final price = `basePrice * multiplier`, then capped at price-cap ceiling if applicable.

---

### 5.2 Calculate Prices (Preview)

```
POST /api/v1/showtimes/:showtimeId/calculate-prices
```

**Headers**: `Authorization: Bearer <access_token>` (customer auth)

**Body**

```json
{ "seatIds": [1, 2, 3, 11] }
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "showtimeId": 101,
    "totalPaise": 161000,
    "currency": "INR",
    "items": [
      { "seatId": 1, "basePricePaise": 35000, "finalPricePaise": 35000, "seatType": "standard", "capped": false, "capReason": null },
      { "seatId": 11, "basePricePaise": 35000, "finalPricePaise": 45500, "seatType": "premium", "capped": false, "capReason": null }
    ],
    "appliedCaps": []
  }
}
```

**Errors**: `400` — Invalid seatIds; `409` — Seats no longer available

---

## 6. Authenticated Booking Flow

### 6.1 Hold Seats

```
POST /api/v1/hold-seats
```

**Headers**: `Authorization: Bearer <access_token>`

**Body**

```json
{ "showtimeId": 101, "seatIds": [1, 2, 3] }
```

**Constraints**: Max 10 seats per hold. Hold TTL = 10 minutes.

**Response 201**

```json
{
  "success": true,
  "data": {
    "success": true,
    "heldSeatIds": [1, 2, 3],
    "conflictedSeatIds": [],
    "holdExpiresAt": "2024-04-14T14:10:00Z",
    "holdKey": "movie_hold:st:101:user:42:abc123"
  }
}
```

**Response 409** (partial conflict)

```json
{
  "success": false,
  "message": "Some seats are no longer available",
  "data": {
    "success": false,
    "heldSeatIds": [1],
    "conflictedSeatIds": [2],
    "holdExpiresAt": null,
    "holdKey": null
  }
}
```

---

### 6.2 Release Seats

```
POST /api/v1/hold-seats/:holdKey/release
```

**Body** (alternative to path param)

```json
{ "holdKey": "movie_hold:st:101:user:42:abc123" }
```

**Response 200**

```json
{ "success": true }
```

---

### 6.3 Check Hold Status

```
GET /api/v1/hold-seats/:holdKey/status
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "active": true,
    "ttlSeconds": 345,
    "seatIds": [1, 2, 3],
    "expiresAt": "2024-04-14T14:10:00Z"
  }
}
```

---

### 6.4 Create Booking (from hold)

```
POST /api/v1/bookings
```

**Headers**: `Authorization: Bearer <access_token>`  
**Headers** (optional): `Idempotency-Key: <unique-key>` — prevents double-charge

**Body**

```json
{
  "holdKey": "movie_hold:st:101:user:42:abc123",
  "idempotencyKey": "optional-client-idempotency-key",
  "customerEmail": "user@example.com",
  "customerPhone": "+919876543210",
  "customerName": "Raj Kumar",
  "notes": "Birthday surprise"
}
```

**Flow**:
1. Validates hold key and seats
2. Creates booking with `status: 'pending_payment'`, `payment_status: 'initiated'`
3. Creates payment order via Cashfree
4. Creates booking items and tickets (tickets in `issued` state until payment)
5. Decrements `available_seats`

**Response 201**

```json
{
  "success": true,
  "data": {
    "bookingReference": "MOV7X9K2P",
    "bookingId": 1234,
    "status": "pending_payment",
    "paymentStatus": "initiated",
    "amount": 161000,
    "currency": "INR",
    "seatCount": 3,
    "paymentOrderId": "ORDER_abc123",
    "cashfreePaymentLink": "https://payments.cashfree.com/...",
    "tickets": [
      {
        "ticketUuid": "a1b2c3d4e5f6...",
        "seatLabel": "A1",
        "rowLabel": "A",
        "seatNumber": 1,
        "seatType": "standard",
        "qrData": "{\"ref\":\"MOV7X9K2P\",\"ticket\":\"a1b2c3...\"}",
        "signature": "hmac-sha256-signature"
      }
    ],
    "createdAt": "2024-04-14T13:55:00Z",
    "holdExpiresAt": "2024-04-14T14:10:00Z"
  }
}
```

**Errors**:
- `400` — Missing holdKey, invalid seats
- `401` — Not authenticated
- `409` — Seats no longer available (hold expired)
- `422` — Showtime not on sale, insufficient seats
- `429` — Idempotent request already processed (returns existing booking)

---

### 6.5 Confirm Booking (Post-Payment)

```
POST /api/v1/bookings/confirm
```

**Body**

```json
{
  "bookingReference": "MOV7X9K2P",
  "paymentOrderId": "ORDER_abc123"
}
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "bookingReference": "MOV7X9K2P",
    "status": "confirmed",
    "paymentStatus": "captured",
    "tickets": [
      {
        "ticketUuid": "a1b2c3d4e5f6...",
        "status": "valid",
        "seatLabel": "A1"
      }
    ]
  }
}
```

---

### 6.6 Get My Booking

```
GET /api/v1/bookings/:referenceOrId
```

**Headers**: `Authorization: Bearer <access_token>`

**Response 200**

```json
{
  "success": true,
  "data": {
    "id": 1234,
    "bookingReference": "MOV7X9K2P",
    "userId": 42,
    "movieId": 1,
    "movieTitle": "KGF Chapter 2",
    "cinemaId": 5,
    "cinemaName": "PVR Chennai",
    "screenId": 12,
    "screenName": "Main Hall",
    "showtimeId": 101,
    "showDatetime": "2024-04-14T14:00:00+05:30",
    "endDatetime": "2024-04-14T16:45:00+05:30",
    "amount": 161000,
    "currency": "INR",
    "seatCount": 3,
    "status": "confirmed",
    "paymentStatus": "captured",
    "bookingType": "online",
    "createdAt": "2024-04-14T13:55:00Z",
    "items": [
      {
        "id": 5001,
        "seatLabel": "A1",
        "rowLabel": "A",
        "seatNumber": 1,
        "seatType": "standard",
        "price": 35000,
        "currency": "INR"
      }
    ]
  }
}
```

**Errors**: `404` — Booking not found or not owned by user

---

### 6.7 List My Bookings

```
GET /api/v1/bookings/my
```

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | no | `pending_payment`, `confirmed`, `cancelled`, `refunded`, `expired` |
| `upcoming` | boolean | no | `true` for future showtimes only |
| `page` | number | no | Default 1 |
| `pageSize` | number | no | Default 20, max 50 |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1234,
      "bookingReference": "MOV7X9K2P",
      "movieTitle": "KGF Chapter 2",
      "cinemaName": "PVR Chennai",
      "showDatetime": "2024-04-14T14:00:00+05:30",
      "amount": 161000,
      "seatCount": 3,
      "status": "confirmed",
      "paymentStatus": "captured",
      "bookingType": "online",
      "createdAt": "2024-04-14T13:55:00Z"
    }
  ],
  "pagination": { "total": 5, "page": 1, "pageSize": 20, "totalPages": 1 }
}
```

---

### 6.8 Cancel Booking

```
POST /api/v1/bookings/:referenceOrId/cancel
```

**Body** (optional)

```json
{ "reason": "Change of plans" }
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "bookingReference": "MOV7X9K2P",
    "status": "cancelled",
    "cancelledAt": "2024-04-14T12:00:00Z",
    "refund": {
      "status": "initiated",
      "amountPaise": 161000,
      "estimatedDays": 5
    }
  }
}
```

**Cancellation policy**: Cancellation allowed up to 2 hours before showtime. Refund = 80% of amount (platform fee 20% retained). After showtime: no refund.

---

### 6.9 Get My Tickets

```
GET /api/v1/bookings/:referenceOrId/tickets
```

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 9001,
      "bookingId": 1234,
      "ticketUuid": "a1b2c3d4e5f6...",
      "showtimeId": 101,
      "seatLabel": "A1",
      "rowLabel": "A",
      "seatNumber": 1,
      "seatType": "standard",
      "qrData": "{\"ref\":\"MOV7X9K2P\",\"ticket\":\"a1b2c3...\",\"seat\":\"A1\",\"row\":\"A\",\"showtime\":101,\"bookingType\":\"offline\"}",
      "signature": "sha256-hmac-signature",
      "status": "valid",
      "usedAt": null,
      "revokedAt": null,
      "createdAt": "2024-04-14T13:55:00Z"
    }
  ]
}
```

---

### 6.10 Verify Ticket (Public)

```
GET /api/v1/tickets/:ticketUuid/verify
```

**No auth required.**

**Response 200**

```json
{
  "success": true,
  "data": {
    "ticketUuid": "a1b2c3d4e5f6...",
    "status": "valid",
    "movieTitle": "KGF Chapter 2",
    "cinemaName": "PVR Chennai",
    "cinemaCity": "Chennai",
    "screenName": "Main Hall",
    "showtimeDatetime": "2024-04-14T14:00:00+05:30",
    "showtimeFormat": "imax",
    "showtimeLanguage": "Tamil",
    "seatLabel": "A1",
    "rowLabel": "A",
    "seatNumber": 1,
    "seatType": "standard",
    "bookingReference": "MOV7X9K2P",
    "bookingType": "online",
    "signatureValid": true
  }
}
```

**Ticket statuses**: `valid`, `used` (checked in), `revoked`, `expired`

---

## 7. Organizer Movie Management

**Base path**: `/api/v1/organizer/movies`  
**Auth**: `Authorization: Bearer <organizer_access_token>`  
**Middleware**: `organizerAuthMiddleware` + resource-level permission check

### 7.1 List Org Movies

```
GET /api/v1/organizer/movies/movies
```

**Permission**: `organizer:movies:read`

**Query Params**: `search` (string), `page`, `pageSize`, `status`

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "KGF Chapter 2",
      "slug": "kgf-chapter-2",
      "description": "...",
      "genre": "Action",
      "language": "Tamil",
      "durationMinutes": 165,
      "rating": "U/A",
      "posterUrl": "https://...",
      "status": "published",
      "isFeatured": false,
      "isActive": true,
      "showtimeCount": 12,
      "organizationId": 1,
      "createdAt": "2024-01-15T10:00:00Z",
      "updatedAt": "2024-04-10T08:00:00Z"
    }
  ],
  "pagination": { "total": 8, "page": 1, "pageSize": 25, "totalPages": 1 }
}
```

---

### 7.2 Get Org Movie

```
GET /api/v1/organizer/movies/movies/:id
```

**Permission**: `organizer:movies:read`

**Response 200** — full movie object (same shape as public + `organizationId`, `showtimeCount`)

**Errors**: `404` — Not in your organization

---

### 7.3 Create Movie

```
POST /api/v1/organizer/movies/movies
```

**Permission**: `organizer:movies:write` OR `organizer:movies:publish`

**Body**

```json
{
  "title": "Jawan",
  "description": "Action thriller",
  "genre": "Action",
  "language": "Hindi",
  "durationMinutes": 169,
  "rating": "U/A",
  "posterUrl": "https://...",
  "bannerUrl": "https://...",
  "trailerUrl": "https://...",
  "releaseDate": "2024-09-15",
  "status": "draft"
}
```

**Note**: Managers without `organizer:movies:publish` permission get `status: 'draft'` regardless of input.

**Response 201**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "title": "Jawan",
    "status": "draft",
    ...
  }
}
```

---

### 7.4 Update Movie

```
PUT /api/v1/organizer/movies/movies/:id
PATCH /api/v1/organizer/movies/movies/:id
```

**Permission**: `organizer:movies:write` OR `organizer:movies:publish`

**Body** — partial movie fields (same as create)

**Response 200** — updated movie object

---

### 7.5 Delete Movie

```
DELETE /api/v1/organizer/movies/movies/:id
```

**Permission**: `organizer:movies:delete`

**Response 200**

```json
{ "success": true }
```

**Errors**: `404` — Not found; `409` — Has active showtimes (cannot delete)

---

## 7.6 Cinemas (Organizer)

### List Cinemas

```
GET /api/v1/organizer/movies/cinemas
```

**Permission**: `organizer:cinemas:read`

**Response 200** — array of `{ id, name, slug, address, city, state, phone, screenCount, totalSeatCapacity, facilities, isActive, organizationId, createdAt }`

---

### Create Cinema

```
POST /api/v1/organizer/movies/cinemas
```

**Permission**: `organizer:cinemas:write`

**Body**

```json
{
  "name": "PVR Coimbatore",
  "address": "456 Rs Puram",
  "city": "Coimbatore",
  "state": "Tamil Nadu",
  "latitude": 11.0168,
  "longitude": 76.9558,
  "phone": "+91-422-1234567",
  "facilities": ["parking", "food"]
}
```

**Response 201** — cinema object

---

### Update Cinema

```
PUT /api/v1/organizer/movies/cinemas/:id
PATCH /api/v1/organizer/movies/cinemas/:id
```

**Permission**: `organizer:cinemas:write` OR `organizer:cinemas:delete`

**Response 200** — updated cinema

---

### Delete Cinema

```
DELETE /api/v1/organizer/movies/cinemas/:id
```

**Permission**: `organizer:owner` (owner only)

**Response 200**

```json
{ "success": true }
```

---

## 7.7 Screens (Organizer)

### List Screens

```
GET /api/v1/organizer/movies/screens
```

**Permission**: `organizer:screens:read`

**Query Params**: `cinemaId` (number)

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "cinemaId": 5,
      "cinemaName": "PVR Chennai",
      "screenNumber": 1,
      "name": "Main Hall",
      "screenType": "imax",
      "soundSystem": "Dolby Atmos",
      "seatCapacity": 80,
      "rowLabels": ["A", "B", "C", "D", "E", "F", "G", "H"],
      "seatsPerRow": [10, 10, 10, 10, 10, 10, 10, 10],
      "seatStartNumber": 1,
      "isActive": true,
      "createdAt": "2024-01-10T08:00:00Z",
      "updatedAt": "2024-01-10T08:00:00Z"
    }
  ],
  "pagination": { "total": 4 }
}
```

---

### Create Screen

```
POST /api/v1/organizer/movies/cinemas/:cinemaId/screens
```

**Permission**: `organizer:screens:write`

**Body**

```json
{
  "screenNumber": 2,
  "name": "Mini Hall",
  "screenType": "2d",
  "soundSystem": "Dolby Digital",
  "rowLabels": ["A", "B", "C", "D", "E"],
  "seatsPerRow": [8, 8, 8, 8, 8],
  "seatStartNumber": 1,
  "seatTypes": { "A": "standard", "B": "standard", "C": "premium", "D": "premium", "E": "sofa" },
  "pricingRules": {}
}
```

**Response 201** — screen object

---

### Update Screen

```
PUT /api/v1/organizer/movies/screens/:id
PATCH /api/v1/organizer/movies/screens/:id
```

**Permission**: `organizer:screens:write` OR `organizer:screens:delete`

**Response 200** — updated screen

---

### Delete Screen

```
DELETE /api/v1/organizer/movies/screens/:id
```

**Permission**: `organizer:owner` (owner only)

**Response 200**

```json
{ "success": true }
```

---

## 7.8 Layout Versions (Organizer)

### List Layout Versions

```
GET /api/v1/organizer/movies/screens/:screenId/layout-versions
```

**Permission**: `organizer:screens:read`

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "screenId": 12,
      "versionNumber": 1,
      "name": "Original Layout",
      "description": null,
      "seatCapacity": 80,
      "rowLabels": ["A", "B", "C", "D", "E", "F", "G", "H"],
      "seatsPerRow": [10, 10, 10, 10, 10, 10, 10, 10],
      "seatStartNumber": 1,
      "pricingRules": {},
      "isActive": true,
      "isCurrent": true,
      "createdAt": "2024-01-10T08:00:00Z",
      "updatedAt": "2024-01-10T08:00:00Z"
    }
  ]
}
```

---

### Get Current Layout

```
GET /api/v1/organizer/movies/screens/:screenId/layout-versions/current
```

**Permission**: `organizer:screens:read`

**Response 200** — single `LayoutVersionPublic` or `404`

---

### Create Layout Version

```
POST /api/v1/organizer/movies/screens/:screenId/layout-versions
```

**Permission**: `organizer:owner` (owner only)

**Body**

```json
{
  "name": "Festival Layout — Diwali 2024",
  "description": "Added extra rows for holiday season"
}
```

Creates a new version by cloning the screen's current seats with a new version number.

**Response 201**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "screenId": 12,
    "versionNumber": 2,
    "name": "Festival Layout — Diwali 2024",
    "isCurrent": true,
    ...
  }
}
```

---

### Set Current Layout Version

```
PATCH /api/v1/organizer/movies/layout-versions/:id/set-current
```

**Permission**: `organizer:owner` (owner only)

**Response 200** — updated version with `isCurrent: true`

---

### Get Layout Version Seats

```
GET /api/v1/organizer/movies/layout-versions/:id/seats
```

**Permission**: `organizer:screens:read`

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "layoutVersionId": 1,
      "rowLabel": "A",
      "seatNumber": 1,
      "seatType": "standard",
      "seatCategory": "regular",
      "xPosition": 10,
      "yPosition": 20,
      "isAvailable": true
    }
  ]
}
```

---

## 7.9 Showtimes (Organizer)

### List Showtimes

```
GET /api/v1/organizer/movies/showtimes
```

**Permission**: `organizer:showtimes:read`

**Query Params**: `movieId`, `cinemaId`, `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `page`, `pageSize`

**Response 200** — paginated array of `{ id, movieId, movieTitle, cinemaId, cinemaName, screenId, screenName, showDatetime, endDatetime, language, format, price, currency, totalSeats, availableSeats, bookedSeats, status, isHidden }`

---

### Get Showtime

```
GET /api/v1/organizer/movies/showtimes/:id
```

**Permission**: `organizer:showtimes:read`

**Response 200** — single showtime object

---

### Create Showtime

```
POST /api/v1/organizer/movies/showtimes
```

**Permission**: `organizer:showtimes:write`

**Body**

```json
{
  "movieId": 1,
  "cinemaId": 5,
  "screenId": 12,
  "showDatetime": "2024-04-14T14:00:00+05:30",
  "endDatetime": "2024-04-14T16:45:00+05:30",
  "language": "Tamil",
  "format": "imax",
  "price": 35000,
  "currency": "INR",
  "totalSeats": 80,
  "status": "on_sale"
}
```

**Validation**: End datetime must be after show datetime. Price must be positive. Total seats must match screen capacity. `organization_id` is derived from cinema.

**Response 201** — showtime object with `availableSeats: totalSeats`, `bookedSeats: 0`

---

### Update Showtime

```
PUT /api/v1/organizer/movies/showtimes/:id
PATCH /api/v1/organizer/movies/showtimes/:id
```

**Permission**: `organizer:showtimes:write`

**Body** — partial showtime fields (same as create)

**Response 200** — updated showtime

---

### Delete Showtime

```
DELETE /api/v1/organizer/movies/showtimes/:id
```

**Permission**: `organizer:owner` (owner only)

**Soft delete**: sets `deleted_at`. Cannot delete if confirmed bookings exist.

**Response 200**

```json
{ "success": true }
```

---

## 7.10 Price Caps (Organizer)

### List Price Caps

```
GET /api/v1/organizer/movies/price-caps
```

**Permission**: `organizer:price_caps:read`

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "organizationId": null,
      "city": "Chennai",
      "state": "Tamil Nadu",
      "maxPricePaise": 30000,
      "currency": "INR",
      "appliesTo": "all",
      "isActive": true,
      "notes": "TN government price cap",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### Create Price Cap

```
POST /api/v1/organizer/movies/price-caps
```

**Permission**: `organizer:owner` (owner only)

**Body**

```json
{
  "city": "Chennai",
  "state": "Tamil Nadu",
  "maxPricePaise": 30000,
  "appliesTo": "all",
  "isActive": true,
  "notes": "TN government price cap"
}
```

**`appliesTo` values**: `all`, `standard`, `premium`, `sofa`, `couple`, `wheelchair`

**Response 201** — price cap object

---

### Update Price Cap

```
PUT /api/v1/organizer/movies/price-caps/:id
PATCH /api/v1/organizer/movies/price-caps/:id
```

**Permission**: `organizer:owner` (owner only)

**Response 200** — updated price cap

---

### Delete Price Cap

```
DELETE /api/v1/organizer/movies/price-caps/:id
```

**Permission**: `organizer:owner` (owner only)

**Response 200**

```json
{ "success": true }
```

---

## 8. Organizer Offline (Counter) Bookings

**Base path**: `/api/v1/organizer/movies/offline-bookings`  
**Auth**: `Authorization: Bearer <organizer_access_token>`  
**Middleware**: `organizerAuthMiddleware`

Offline bookings are walk-in / box-office sales. No payment gateway involved. Payment status = `paid_offline`, payment gateway = `manual`.

**Allowed payment methods** (case-sensitive): `CASH`, `UPI`, `CARD`

### 8.1 Create Offline Booking

```
POST /api/v1/organizer/movies/offline-bookings
```

**Permission**: `organizer:bookings:write` OR `organizer:bookings:delete`

**Body**

```json
{
  "showtimeId": 101,
  "seatIds": [1, 2, 3],
  "customerName": "Arun Kumar",
  "customerEmail": "arun@example.com",
  "customerPhone": "+919876543210",
  "paymentMethod": "CASH",
  "paymentReference": "",
  "notes": "Birthday group"
}
```

**Validation**:
- `showtimeId` — must exist, be `on_sale`, have enough seats
- `seatIds` — must all be valid, available, and on the correct screen
- `paymentMethod` — must be `CASH`, `UPI`, or `CARD` (case-sensitive)
- If `UPI`, `paymentReference` (UPI txn ID) is required
- Max 20 seats per offline booking
- Idempotent: same sorted seat set returns existing booking

**Response 201**

```json
{
  "success": true,
  "data": {
    "booking": {
      "id": 2001,
      "bookingReference": "OFMOVxYzAbCdEf",
      "userId": 5,
      "organizationId": 1,
      "movieId": 1,
      "cinemaId": 5,
      "cinemaScreenId": 12,
      "showtimeId": 101,
      "amount": 115500,
      "currency": "INR",
      "seatCount": 3,
      "bookingType": "offline",
      "offlineByUserId": 5,
      "customerEmail": "arun@example.com",
      "customerPhone": "+919876543210",
      "customerName": "Arun Kumar",
      "status": "confirmed",
      "paymentStatus": "paid_offline",
      "createdAt": "2024-04-14T14:05:00Z",
      "updatedAt": "2024-04-14T14:05:00Z"
    },
    "paymentOrderId": "OFMOV_1713120000_A1B2C3D4",
    "tickets": [
      {
        "ticketUuid": "f6e5d4c3b2a1...",
        "seatLabel": "A1",
        "rowLabel": "A",
        "seatNumber": 1,
        "seatType": "standard",
        "signature": "hmac-sha256-...",
        "qrData": "{\"ref\":\"OFMOVxYzAbCdEf\",\"ticket\":\"f6e5d4...\",\"seat\":\"A1\",\"row\":\"A\",\"showtime\":101,\"bookingType\":\"offline\"}"
      }
    ]
  }
}
```

**Errors**:
- `400` — Missing fields, invalid payment method, UPI missing reference
- `401` — Not authenticated as organizer
- `403` — Not authorized for this organization
- `409` — Seats already booked (double-booking prevented by DB constraint + pre-check)
- `422` — Showtime not available

---

### 8.2 List Offline Bookings

```
GET /api/v1/organizer/movies/offline-bookings
```

**Permission**: `organizer:bookings:read`

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `page` | number | no | Default 1 |
| `pageSize` | number | no | Default 25, max 100 |
| `from` | string (YYYY-MM-DD) | no | Filter from date |
| `to` | string (YYYY-MM-DD) | no | Filter to date |

**Response 200**

```json
{
  "success": true,
  "data": [
    {
      "id": 2001,
      "bookingReference": "OFMOVxYzAbCdEf",
      "movieId": 1,
      "movieTitle": "KGF Chapter 2",
      "cinemaName": "PVR Chennai",
      "screenName": "Main Hall",
      "showDatetime": "2024-04-14T14:00:00+05:30",
      "amount": 115500,
      "seatCount": 3,
      "paymentStatus": "paid_offline",
      "customerName": "Arun Kumar",
      "customerPhone": "+919876543210",
      "offlineByUserId": 5,
      "createdAt": "2024-04-14T14:05:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 25,
    "total": 47,
    "totalPages": 2
  }
}
```

---

### 8.3 Get Offline Booking Details

```
GET /api/v1/organizer/movies/offline-bookings/:id
```

**Permission**: `organizer:bookings:read`

**Response 200**

```json
{
  "success": true,
  "data": {
    "booking": {
      "id": 2001,
      "bookingReference": "OFMOVxYzAbCdEf",
      "movieId": 1,
      "movieTitle": "KGF Chapter 2",
      "posterUrl": "https://...",
      "cinemaId": 5,
      "cinemaName": "PVR Chennai",
      "cinemaAddress": "123 T Nagar, Chennai",
      "cinemaCity": "Chennai",
      "cinemaPhone": "+91-44-12345678",
      "screenId": 12,
      "screenName": "Main Hall",
      "showtimeId": 101,
      "showDatetime": "2024-04-14T14:00:00+05:30",
      "endDatetime": "2024-04-14T16:45:00+05:30",
      "language": "Tamil",
      "format": "imax",
      "amount": 115500,
      "currency": "INR",
      "seatCount": 3,
      "bookingType": "offline",
      "paymentStatus": "paid_offline",
      "customerEmail": "arun@example.com",
      "customerPhone": "+919876543210",
      "customerName": "Arun Kumar",
      "offlineByUserId": 5,
      "createdAt": "2024-04-14T14:05:00Z"
    },
    "cinema": { ... },
    "screen": { ... },
    "showtime": { ... },
    "movie": { ... },
    "items": [
      {
        "id": 3001,
        "seatLabel": "A1",
        "rowLabel": "A",
        "seatNumber": 1,
        "seatType": "standard",
        "price": 35000,
        "ticket": {
          "ticketUuid": "f6e5d4c3b2a1...",
          "status": "valid",
          "qrData": "...",
          "signature": "..."
        }
      }
    ]
  }
}
```

**Errors**: `404` — Booking not found or not in your organization

---

## 9. Admin Movie Management

**Base path**: `/api/v1/admin/movies`  
**Auth**: `Authorization: Bearer <admin_access_token>`  
**Middleware**: `adminAuthMiddleware` + `requirePermission('...')` + `auditMiddleware`

### 9.1 List All Movies (Admin)

```
GET /api/v1/admin/movies
```

**Permission**: `movies:read`

**Query Params**: `search`, `status`, `page`, `pageSize`

**Response 200** — paginated array of movie objects with organization info

---

### 9.2 Create Movie (Admin)

```
POST /api/v1/admin/movies
```

**Permission**: `movies:write`  
**Audit**: `movie.create`

**Body** — same as organizer create

**Response 201**

---

### 9.3 Update Movie (Admin)

```
PUT /api/v1/admin/movies/:id
PATCH /api/v1/admin/movies/:id
```

**Permission**: `movies:write`  
**Audit**: `movie.update`

**Response 200**

---

### 9.4 Delete Movie (Admin)

```
DELETE /api/v1/admin/movies/:id
```

**Permission**: `movies:delete`  
**Audit**: `movie.delete`

**Response 200**

---

### 9.5 Publish Movie

```
POST /api/v1/admin/movies/:id/publish
```

**Permission**: `movies:publish`  
**Audit**: `movie.publish`

**Response 200** — movie with `status: "published"`

---

### 9.6 Archive Movie

```
POST /api/v1/admin/movies/:id/archive
```

**Permission**: `movies:publish`  
**Audit**: `movie.archive`

**Response 200** — movie with `status: "archived"`

---

### 9.7 Cinemas (Admin)

Full CRUD at `/api/v1/admin/movies/cinemas` with `movies:read` / `movies:write` / `movies:delete` permissions. Plus:

```
POST /api/v1/admin/movies/cinemas/:id/toggle
```

**Permission**: `movies:write`  
**Audit**: `cinema.toggle`

Toggles `is_active` flag. Body: `{ "isActive": false }`

---

### 9.8 Screens (Admin)

Full CRUD at:
- `POST /api/v1/admin/movies/cinemas/:cinemaId/screens`
- `PUT /api/v1/admin/movies/screens/:screenId`
- `PATCH /api/v1/admin/movies/screens/:screenId`
- `DELETE /api/v1/admin/movies/screens/:screenId`

Permissions: `movies:write` / `movies:delete`

---

### 9.9 Screen Layout Versions (Admin)

```
GET /api/v1/admin/movies/screens/:screenId/layout
GET /api/v1/admin/movies/screens/:screenId/layout/versions
PATCH /api/v1/admin/movies/screens/:screenId/layout/versions/:versionId/current
POST /api/v1/admin/movies/screens/:screenId/layout/versions
POST /api/v1/admin/movies/screens/:screenId/layout/sync
```

**Permissions**: `movies:read` (GET), `movies:write` (mutations)  
**Audit**: `layout_version.set_current`, `layout_version.create`, `screen.layout_sync`

---

### 9.10 Showtimes (Admin)

```
GET /api/v1/admin/movies/showtimes
GET /api/v1/admin/movies/cinemas/:cinemaId/showtimes
GET /api/v1/admin/movies/movies/:movieId/showtimes
GET /api/v1/admin/movies/showtimes/stats
POST /api/v1/admin/movies/showtimes
PUT /api/v1/admin/movies/showtimes/:id
PATCH /api/v1/admin/movies/showtimes/:id
DELETE /api/v1/admin/movies/showtimes/:id
```

**Permissions**: `movies:read` (read), `movies:write` (create/update), `movies:delete` (delete)

---

### 9.11 Price Caps (Admin)

```
GET /api/v1/admin/movies/price-caps
POST /api/v1/admin/movies/price-caps
PUT /api/v1/admin/movies/price-caps/:id
PATCH /api/v1/admin/movies/price-caps/:id
DELETE /api/v1/admin/movies/price-caps/:id
```

**Permissions**: `movies:read` / `movies:write` / `movies:delete`

---

## 10. Movie Scanner (Ticket Verification)

**Base path**: `/api/v1/scan/movies`  
**Auth**: `Authorization: Bearer <admin_access_token>`  
**Middleware**: `adminAuthMiddleware` + `requirePermission('scanner:verify')` / `requirePermission('scanner:checkin')`

### 10.1 Verify Ticket

```
POST /api/v1/scan/movies/verify
```

**Permission**: `scanner:verify`

**Body**

```json
{ "ticket_uuid": "a1b2c3d4e5f6..." }
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "ticketUuid": "a1b2c3d4e5f6...",
    "status": "valid",
    "bookingReference": "MOV7X9K2P",
    "movieTitle": "KGF Chapter 2",
    "cinemaName": "PVR Chennai",
    "screenName": "Main Hall",
    "showDatetime": "2024-04-14T14:00:00+05:30",
    "seatLabel": "A1",
    "rowLabel": "A",
    "seatNumber": 1,
    "seatType": "standard",
    "bookingType": "online",
    "signatureValid": true,
    "canCheckIn": true
  }
}
```

---

### 10.2 Mark Ticket Checked-In

```
POST /api/v1/scan/movies/mark
```

**Permission**: `scanner:checkin`

**Body**

```json
{ "ticket_uuid": "a1b2c3d4e5f6..." }
```

**Response 200**

```json
{
  "success": true,
  "data": {
    "ticketUuid": "a1b2c3d4e5f6...",
    "status": "used",
    "usedAt": "2024-04-14T14:08:00Z",
    "usedBy": 3,
    "seatLabel": "A1"
  }
}
```

**Errors**: `400` — Already used; `404` — Ticket not found; `403` — Signature invalid

---

## 11. Owner Analytics — Movies

**Base path**: `/api/v1/owner/movies/analytics`  
**Auth**: `Authorization: Bearer <organizer_access_token>`  
**Middleware**: `organizerAuthMiddleware`

### 11.1 Movie Analytics

```
GET /api/v1/owner/movies/analytics
```

**Query Params**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string (YYYY-MM-DD) | no | Start date (default: 30 days ago) |
| `to` | string (YYYY-MM-DD) | no | End date (default: today) |

**Response 200**

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalRevenuePaise": 2450000,
      "bookingCount": 42,
      "onlineBookingCount": 35,
      "offlineBookingCount": 7,
      "avgBookingValuePaise": 58333,
      "topMovie": {
        "title": "KGF Chapter 2",
        "revenuePaise": 1200000,
        "bookingCount": 18
      }
    },
    "daily": [
      {
        "date": "2024-04-10",
        "revenuePaise": 145000,
        "bookingCount": 5,
        "offlineCount": 1,
        "onlineCount": 4
      }
    ],
    "topMovies": [
      {
        "title": "KGF Chapter 2",
        "revenuePaise": 1200000,
        "bookingCount": 18
      },
      {
        "title": "Jawan",
        "revenuePaise": 800000,
        "bookingCount": 14
      }
    ],
    "paymentBreakdown": [
      { "paymentMethod": "online", "count": 35, "revenuePaise": 2000000 },
      { "paymentMethod": "offline", "count": 7, "revenuePaise": 450000 }
    ]
  }
}
```

---

## 12. Movie Payment Webhooks

**Base path**: `/api/v1/movies/webhooks/cashfree`  
**Auth**: Raw body signature verification (Cashfree HMAC-SHA256)  
**Middleware**: Raw body capture + signature validation

### 12.1 Cashfree Payment Webhook

```
POST /api/v1/movies/webhooks/cashfree
```

**Headers**: `x-webhook-signature: <signature>`, `x-webhook-timestamp: <timestamp>`

**Body** (Cashfree format)

```json
{
  "orderId": "ORDER_abc123",
  "orderToken": "...",
  "paymentStatus": "PAID",
  "paymentMethod": "upi",
  "paymentTime": "2024-04-14T14:02:00+05:30",
  "amount": 161000,
  "cfPaymentId": "cf_pay_1234567890"
}
```

**Behavior**: Idempotent — processes webhook only once per event. Updates `payment_orders` → `COMPLETED`, then `movie_bookings` → `payment_status = 'captured'`, `status = 'confirmed'`.

**Response 200**

```json
{ "success": true }
```

---

## 13. Error Codes & Conventions

| HTTP Status | Meaning | Example |
|-------------|---------|---------|
| `200` | OK | Successful GET/POST |
| `201` | Created | Booking, movie, cinema created |
| `400` | Bad Request | Missing required fields, invalid enum value |
| `401` | Unauthorized | Missing/invalid token |
| `403` | Forbidden | Insufficient permissions, org mismatch |
| `404` | Not Found | Resource doesn't exist or is soft-deleted |
| `409` | Conflict | Seat already booked, hold expired |
| `422` | Unprocessable | Showtime not on sale, insufficient seats |
| `429` | Too Many Requests | Idempotent duplicate, rate limited |
| `500` | Server Error | Unexpected failure |

### Error Response Format

```json
{
  "success": false,
  "message": "Human-readable error message",
  "errors": {
    "fieldName": ["Validation error detail"]
  }
}
```

### Pagination Format

```json
{
  "pagination": {
    "total": 42,
    "page": 1,
    "pageSize": 25,
    "totalPages": 2
  }
}
```

---

## Appendix A — Type Definitions Reference

Key types exported from `src/types/index.ts`:

```typescript
// Booking
type MovieBookingType = 'online' | 'offline' | 'complimentary';
type MoviePaymentStatus = 'initiated' | 'pending' | 'captured' | 'failed' | 'refunded' | 'paid_offline';
type MovieBookingStatus = 'pending_payment' | 'confirmed' | 'cancelled' | 'expired' | 'refunded' | 'completed';
type OfflinePaymentMethod = 'CASH' | 'UPI' | 'CARD';
type PaymentGateway = 'cashfree' | 'manual';

// Seats
type MovieSeatType = 'standard' | 'premium' | 'sofa' | 'wheelchair';
type MovieSeatCategory = 'regular' | 'couple' | 'recliner';

// Showtime
type ShowtimeFormat = '2d' | '3d' | 'imax' | 'imax_3d';
type ShowtimeStatus = 'draft' | 'on_sale' | 'sold_out' | 'cancelled' | 'ended';
type PriceCapAppliesTo = 'all' | 'standard' | 'premium' | 'sofa' | 'couple' | 'wheelchair';

// Ticket
type MovieTicketStatus = 'valid' | 'used' | 'revoked' | 'expired';
```

---

## Appendix B — URL Mounting Summary

All routes are mounted at **two prefixes** for backward compatibility:

| Path variant | Example |
|-------------|---------|
| Versioned | `/api/v1/movies`, `/api/v1/organizer/movies`, `/api/v1/admin/movies`, `/api/v1/scan/movies`, `/api/v1/owner/movies/analytics`, `/api/v1/movies/webhooks` |
| Legacy | `/api/movies`, `/api/organizer/movies`, `/api/admin/movies`, `/api/scan/movies`, `/api/owner/movies/analytics`, `/api/movies/webhooks` |

The versioned (`/api/v1`) prefix is the recommended consumer interface. Legacy (`/api`) is deprecated but fully functional.
