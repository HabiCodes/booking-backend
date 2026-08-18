# Movie Ticket Booking — API Contracts

## Base URL
```
/api/v1/movies
```

All monetary amounts are in **paise** (INR × 100). All timestamps are ISO 8601 in IST.

---

## 1. Discovery (Public)

### `GET /movies`
List now-showing movies. Optional filters: `city`, `genre`, `language`, `status`, `featured`, `search`, `page`, `pageSize`.

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Pushpa 2",
      "originalTitle": null,
      "slug": "pushpa-2",
      "synopsis": "...",
      "genre": ["Action", "Drama"],
      "language": "Telugu",
      "durationMinutes": 180,
      "cast": ["Allu Arjun", "Rashmika"],
      "director": "Sukumar",
      "posterUrl": "https://...",
      "backdropUrl": "https://...",
      "trailerUrl": "https://...",
      "rating": 4.5,
      "censorRating": "A",
      "releaseDate": "2024-12-05",
      "status": "now_showing",
      "organizationId": 1,
      "isFeatured": true,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "pagination": { "total": 50, "page": 1, "pageSize": 20, "totalPages": 3 }
}
```

### `GET /movies/:slugOrId`
Movie detail page. Returns full movie object.

### `GET /movies/featured?limit=8`
Featured movies list.

### `GET /movies/genres`
Distinct genre list.

### `GET /movies/languages`
Distinct language list.

### `GET /showtimes?movieId=1&city=Chennai&date=2024-12-10&cinemaId=3`
List showtimes filtered by movie, city, date, cinema. Returns upcoming `on_sale` showtimes.

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": 42,
      "movieId": 1,
      "cinemaId": 3,
      "screenId": 5,
      "organizationId": 1,
      "showDatetime": "2024-12-10T14:00:00+05:30",
      "endDatetime": "2024-12-10T17:00:00+05:30",
      "language": "Telugu",
      "format": "2D",
      "price": 25000,
      "currency": "INR",
      "totalSeats": 120,
      "availableSeats": 45,
      "bookedSeats": 75,
      "status": "on_sale",
      "isHidden": false
    }
  ]
}
```

### `GET /showtimes/cities`
Cities with active showtimes.

### `GET /showtimes/:idOrSlug`
Single showtime detail. Excludes `is_hidden` showtimes.

### `GET /cinemas?city=Chennai&state=TN`
Active cinemas by city/state.

### `GET /cinemas/city/:city`
Cinemas in a specific city.

### `GET /cinemas/:idOrSlug`
Cinema detail.

### `GET /cinemas/:cinemaId/screens`
Screens for a cinema.

---

## 2. Seat Layout (Public)

### `GET /showtimes/:showtimeId/seats`
Complete structured seat layout with pricing, availability, and positioning.

**Response 200**
```json
{
  "success": true,
  "data": {
    "showtimeId": 42,
    "screenId": 5,
    "price": 25000,
    "currency": "INR",
    "rows": [
      {
        "rowLabel": "A",
        "seats": [
          {
            "seatId": 1,
            "seatNumber": 1,
            "seatType": "standard",
            "seatCategory": "regular",
            "xPosition": 50,
            "yPosition": 100,
            "status": "available",
            "pricePaise": 25000
          },
          {
            "seatId": 2,
            "seatNumber": 2,
            "seatType": "premium",
            "seatCategory": "premium",
            "xPosition": 120,
            "yPosition": 100,
            "status": "held",
            "pricePaise": 32500
          }
        ]
      }
    ]
  }
}
```

**Seat statuses:**
- `available` — free to book
- `held` — temporarily reserved in Redis by another user (TTL-based)
- `booked` — confirmed or pending payment in DB

**Seat types:** `standard`, `premium`, `sofa`, `couple`, `wheelchair`

**Seat categories:** `regular`, `premium`

**Price calculation:**
- Base price = showtime price
- Multipliers: standard ×1.0, premium ×1.3, sofa ×1.6, couple ×1.5, wheelchair ×1.0
- Tamil Nadu price cap applied if configured (max_price_paise)

---

## 3. Booking (Authenticated)

### `POST /showtimes/:showtimeId/calculate-prices`
Calculate prices for selected seats without holding.

**Request**
```json
{ "seatIds": [1, 2, 3] }
```

**Response 200**
```json
{
  "success": true,
  "data": [
    { "seatId": 1, "basePricePaise": 25000, "finalPricePaise": 25000, "seatType": "standard", "capped": false, "capReason": null },
    { "seatId": 2, "basePricePaise": 25000, "finalPricePaise": 32500, "seatType": "premium", "capped": false, "capReason": null }
  ]
}
```

### `POST /hold-seats`
Hold seats in Redis (10-minute TTL).

**Request** (URL param: showtimeId)
```json
{ "seatIds": [1, 2, 3] }
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "success": true,
    "heldSeatIds": [1, 2, 3],
    "conflictedSeatIds": [],
    "holdExpiresAt": "2024-12-10T13:55:00+05:30",
    "holdKey": "movie:hold:42:abc123"
  }
}
```

**Response 409** — seats no longer available
```json
{
  "success": false,
  "message": "Some seats are no longer available",
  "data": { "success": false, "heldSeatIds": [1], "conflictedSeatIds": [2, 3] }
}
```

### `POST /hold-seats/:holdKey/release`
Release a hold early.

### `GET /hold-seats/:holdKey/status`
Check hold TTL and seat list.

### `POST /bookings`
Create a booking from held seats. Starts Cashfree payment.

**Request**
```json
{
  "holdKey": "movie:hold:42:abc123",
  "customerEmail": "user@example.com",
  "customerPhone": "+919876543210",
  "customerName": "John Doe",
  "notes": "Window seat please",
  "idempotencyKey": "optional-client-key"
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": 101,
    "bookingReference": "MOVXYZ123ABC",
    "userId": 5,
    "movieId": 1,
    "cinemaId": 3,
    "cinemaScreenId": 5,
    "showtimeId": 42,
    "status": "pending_payment",
    "amount": 82500,
    "currency": "INR",
    "seatCount": 3,
    "holdKey": "movie:hold:42:abc123",
    "paymentOrderId": "cf_order_xxx",
    "paymentSessionId": "cf_session_xxx",
    "paymentUrl": "https://pay.cashfree.com/...",
    "customerEmail": "user@example.com",
    "customerPhone": "+919876543210",
    "customerName": "John Doe",
    "notes": "Window seat please",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

### `POST /bookings/confirm`
Confirm booking after payment success (idempotent).

**Request**
```json
{
  "bookingReference": "MOVXYZ123ABC",
  "paymentOrderId": "cf_order_xxx"
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": 101,
    "bookingReference": "MOVXYZ123ABC",
    "status": "confirmed",
    ...
  }
}
```

### `GET /bookings/my?status=confirmed&upcoming=true&page=1&pageSize=20`
User's bookings.

### `GET /bookings/:referenceOrId`
Single booking detail.

### `POST /bookings/:referenceOrId/cancel`
Cancel booking (only pending_payment).

### `GET /bookings/:referenceOrId/tickets`
Tickets for a booking.

---

## 4. Tickets (Authenticated)

### `GET /tickets/:ticketUuid/verify`
Verify ticket validity (used by scanner).

### `GET /tickets/:ticketUuid/details`
Ticket details with QR data.

**Ticket response**
```json
{
  "success": true,
  "data": {
    "uuid": "tkt_abc123",
    "seatLabel": "A5",
    "rowLabel": "A",
    "movieTitle": "Pushpa 2",
    "cinemaName": "PVR Chennai",
    "screenNumber": 5,
    "showtime": "2024-12-10T14:00:00+05:30",
    "checkedIn": false,
    "checkedInAt": null,
    "signatureValid": true,
    "qrCode": "data:image/png;base64,..."
  }
}
```

---

## 5. Scanner (Admin — `ticket_scanner` role)

### `GET /tickets/:ticketUuid/verify` (admin)
**Scan statuses:**
- `VALID` — ticket is valid for entry
- `ALREADY_SCANNED` — ticket already used
- `INVALID` — ticket doesn't exist or revoked
- `EXPIRED` — showtime has ended

### `POST /tickets/:ticketUuid/checkin`
Mark ticket as checked in (atomic `status = 'valid' → 'used'`).

---

## 6. Webhooks (Cashfree — POST /webhooks/cashfree)

Raw body required (captured before JSON parsing). Signature: HMAC-SHA256 with webhook secret.

**Supported events:** `ORDER_CREATED`, `PAYMENT_SUCCESS`, `PAYMENT_FAILED`, `PAYMENT_CANCELLED`, `ORDER_EXPIRED`, `REFUND`, `REFUND_SUCCESS`, `REFUND_FAILED`

**Idempotency:** Deterministic key `movie_webhook_{orderId}_{eventType}`. Duplicate events return `{ "success": true, "message": "Already processed" }`.

---

## Error Responses

All endpoints return consistent error shapes:

```json
{ "success": false, "message": "Error description" }
```

| Status | Meaning |
|--------|---------|
| 400 | Invalid input / missing parameters |
| 401 | Authentication required |
| 403 | Not authorized |
| 404 | Resource not found |
| 409 | Conflict (seats unavailable, booking state mismatch) |
| 422 | Business rule violation |
| 429 | Too many requests |
| 500 | Server error |

---

## Authentication

All booking and ticket endpoints require Bearer token in `Authorization: header`. Scanner endpoints require `ticket_scanner` role with `scanner:verify` and `scanner:checkin` permissions.

Discovery endpoints (movies, cinemas, showtimes, seat layout) are public.
