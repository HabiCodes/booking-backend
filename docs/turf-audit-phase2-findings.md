# TURF SYSTEM — PHASE 2 AUDIT REPORT
## Slot Generation Deep Audit + Complete Findings Classification

**Date:** 2026-08-31  
**Scope:** All 17 audit areas from production-readiness directive  
**Business Rules:** ZERO alterations — all findings are infrastructure/correctness bugs only

---

## SECTION A: SLOT GENERATION DEEP AUDIT

### Scenario A: Same second, two requests for the same slot

**Current behavior:**
- `POST /api/v1/turf/bookings` calls `createBooking()` which does `SELECT * FROM turf_availability_units WHERE id = $1 FOR UPDATE`
- The unit row is locked for the duration of the transaction
- After the lock is acquired, the code proceeds to INSERT the booking

**FINDING — CRITICAL:** The unit's status is NEVER changed during booking creation.
- `createBooking` calls `turfAvailabilityRepository.markPaymentPending(unit.id, userId)` which executes:
  ```sql
  UPDATE turf_availability_units SET status = 'payment_pending', ...
  WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
  ```
- But the unit is in `'available'` status with no `lock_holder_id` when booking starts
- This UPDATE matches **0 rows** — it's a silent no-op
- When Request A commits, the unit is still `'available'`
- Request B (which was waiting on the FOR UPDATE lock) now sees `'available'` and proceeds
- **Both requests create bookings for the same unit**

The `uq_turf_booking_au_confirmed` partial unique index prevents two CONFIRMED bookings on the same unit, but does NOT prevent two `pending_payment` bookings.

**Real-world impact:** Two customers can pay for the same turf slot. The first to pay gets confirmed; the second gets a payment confirmation error. Customer frustration, refund disputes.

**Concurrency impact:** HIGH — race window exists between FOR UPDATE lock release and unit status check of next request.

**Data integrity impact:** Two bookings reference the same availability unit. One will fail confirmation.

**Fix:** Change `markPaymentPending` to accept `'available'` as a valid source status:
```sql
WHERE id = $1 AND status IN ('available', 'locked') AND (lock_holder_id = $2 OR lock_holder_id IS NULL)
```
Or add a separate `reserveForPayment` method that transitions `available → payment_pending`.

---

### Scenario B: Concurrent holds + booking for same slot

**Current behavior:**
- `acquireHold` uses a DB transaction with `SELECT FOR UPDATE` on the unit
- The `uq_turf_hold_active_unit` partial unique index on `turf_holds(availability_unit_id) WHERE status='active'` prevents two active holds
- `createBooking` doesn't use holds — it goes straight to INSERT booking

**Finding:** The hold system and booking system are **disconnected**. `createBooking` never creates a `turf_holds` record. The hold flow (`acquireHold` → `confirmHold`) is for a separate "hold-then-pay" flow that's not wired into the booking flow.

If both flows are used concurrently:
1. Customer A uses hold flow → unit → `locked`, hold record created
2. Customer B uses booking flow → `SELECT FOR UPDATE` on unit → blocked by A's lock
3. Customer A confirms → `confirmHold` → unit → `booked`
4. Customer B's SELECT FOR UPDATE unblocks → unit.status = `'booked'` → fails "Slot no longer available"

This path is actually safe because of the FOR UPDATE lock. But if Customer A's hold expires (5 min) and `expireStaleHolds` releases it, Customer B could book it. Safe.

---

### Scenario C: 15-day rolling window — generation correctness

**Current behavior:**
- `getISTDate()` calculates today in IST using `now.getTime() + IST_OFFSET_MS`
- Window is tomorrow through +15 days (excludes today)
- `buildSlotWindows` in `turfAvailabilityService` correctly uses `+05:30` timezone

**Finding:** The service-layer `buildSlotWindows` is correct. It creates `new Date(\`${date}T${startTime}:00+05:30\`)` which properly interprets the time in IST.

The repository's `generateSlots` has an IST/UTC offset bug (adds then subtracts IST_OFFSET = no-op), but **this method is never called** — dead code. The service method is the one in production use and it's correct.

**Verdict:** No issue in production code path.

---

### Scenario D: Slot already booked — idempotency

**Current behavior:**
- `ON CONFLICT (resource_id, starts_at, ends_at) WHERE seat_label IS NULL AND total_capacity IS NULL DO NOTHING`
- Partial unique index on slot-based units only

**Finding:** Correct. The partial unique index matches exactly the slot_based rows (where seat_label and total_capacity are NULL). Idempotent regeneration is safe.

---

### Scenario E: Cancellation and re-booking of the same slot

**Current behavior:**
- `cancelBooking` calls `turfAvailabilityRepository.markAvailable(unitId)`:
  ```sql
  UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1
  ```
- No status guard — transitions from ANY status to 'available'
- Coupon usage is decremented inside the transaction

**Finding — MEDIUM:** `markAvailable` has no status check. If called on a unit that's already been marked available by another concurrent cancellation, it's a harmless no-op. But if called on a unit that's in a transitional state, it could bypass state checks. Low risk because it's inside a transaction with SELECT FOR UPDATE on the booking.

**Data integrity impact:** Low — the booking's FOR UPDATE lock serializes cancellations.

---

### Scenario F: Different resource types in same venue

**Current behavior:**
- `generateForVenue` filters `resource_type === 'slot_based'`
- `getVenueSchedule` reads from first active resource's schedule
- Seat_based and zone_based resources are not affected

**Finding:** Correct isolation. Different resource types don't interfere.

---

### Scenario G: Overlapping windows within a resource

**Current behavior:**
- `buildSlotWindows` creates non-overlapping consecutive slots: cursor advances by `durationMinutes` each iteration
- `windowEnd > end` breaks the loop

**Finding:** Correct. Slots are contiguous, non-overlapping, and cover the entire [startTime, endTime] range minus the last partial window.

---

### Scenario H: Server restart mid-generation

**Current behavior:**
- Each slot INSERT uses `ON CONFLICT DO NOTHING`
- If the process crashes mid-generation, already-created slots remain
- Re-running generation skips existing slots

**Finding:** Correct. Idempotent by design.

---

### Scenario I: DST/timezone edge cases

**Current behavior:**
- Asia/Kolkata does NOT observe DST (fixed +05:30 offset)
- `buildSlotWindows` hardcodes `+05:30`
- DB connections set `TIME ZONE 'Asia/Kolkata'`

**Finding:** Correct. No DST concerns for IST.

---

### Scenario J: Slot duration > operating hours

**Current behavior:**
- `buildSlotWindows` breaks when `windowEnd > end`
- `createBooking` checks `slotDurationMs > 4 * 60 * 60 * 1000` (max 4 hours)

**Finding:** Correct. Oversized slots are pruned during generation, and booking enforces 4-hour max.

---

### Scenario K: Legacy lock vs. hold system coexistence

**Current behavior:**
- Legacy Redis `turf:slot_lock:{unitId}` with 10s TTL (from `turfAvailabilityService`)
- New hold system uses `turf_holds` table with 5-min TTL
- Both can exist on the same unit

**Finding — MEDIUM:** Dual systems create confusion. If a Redis lock expires (10s) but the DB hold is still active, the unit could be booked by another customer who only checks Redis. However, `createBooking` does SELECT FOR UPDATE on the unit and checks unit.status, not Redis. The hold flow uses FOR UPDATE too. So the DB is authoritative and Redis is only a hint.

**Verdict:** Safe but unnecessarily complex. Legacy lock system could be removed after migration.

---

### Scenario L: Partial unique index correctness

**Current behavior:**
- `CREATE UNIQUE INDEX uq_turf_au_resource_slot ON turf_availability_units(resource_id, starts_at, ends_at) WHERE seat_label IS NULL AND total_capacity IS NULL`

**Finding:** Correct. This index only applies to slot_based units (where seat_label and total_capacity are NULL). Seat_based and zone_based units have different uniqueness constraints.

---

## SECTION B: COMPLETE FINDINGS CLASSIFICATION

### CRITICAL FINDINGS (Launch Blockers)

---

#### FINDING 1: No actual booking lock in createBooking — double-booking possible

**File:** `src/services/turfBookingService.ts` (line 242), `src/repositories/turfAvailabilityRepository.ts` (line 125-134)

**Current behavior:** When a customer creates a booking, the unit is in `'available'` status. `markPaymentPending` only transitions `'locked' → 'payment_pending'` (checking `status = 'locked' AND lock_holder_id = $2`). Since the unit is `'available'` with no `lock_holder_id`, the UPDATE matches 0 rows. The unit stays `'available'`.

**Exact problem:** Two concurrent `createBooking` requests for the same unit can both succeed because:
1. Request A: FOR UPDATE locks unit, sees 'available', INSERTs booking, markPaymentPending is no-op, COMMIT
2. Request B: FOR UPDATE waits, then locks unit, sees STILL 'available' (because markPaymentPending was no-op), INSERTs its own booking, COMMIT

Both bookings are `pending_payment`. The `uq_turf_booking_au_confirmed` partial unique index only blocks CONFIRMED double-bookings, not `pending_payment`.

**Real-world impact:** Two customers can initiate payment for the same slot. First to pay gets confirmed; second gets payment confirmation error. Refund disputes, customer frustration.

**Concurrency impact:** CRITICAL — happens naturally under concurrent load (flash sales, popular time slots).

**Data integrity impact:** Two bookings reference one availability unit. One is permanently stuck in `pending_payment` or `expired`.

**Security impact:** Indirect — could enable denial-of-service by draining inventory.

**Scale impact:** Worsens with load. More concurrent requests = higher probability.

**Recommended fix:**
```typescript
// In turfAvailabilityRepository.ts — change markPaymentPending:
async markPaymentPending(unitId: number, holderId: number): Promise<TurfAvailabilityUnitRow | null> {
  const { rows } = await getPool().query(
    `UPDATE turf_availability_units
     SET status = 'payment_pending', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
     WHERE id = $1 AND status IN ('available', 'locked')
       AND (lock_holder_id = $2 OR status = 'available')
     RETURNING *`,
    [unitId, holderId]
  );
  return rows.length > 0 ? (rows[0] as TurfAvailabilityUnitRow) : null;
}
```

**Business-rule impact:** NONE — preserves existing booking flow, payment timeout, cancellation rules.

**Launch blocker:** YES

---

#### FINDING 2: markBooked checks wrong status — confirmed bookings leave unit in wrong state

**File:** `src/repositories/turfAvailabilityRepository.ts` (line 136-141)

**Current behavior:**
```sql
UPDATE turf_availability_units SET status = 'booked' WHERE id = $1 AND status = 'locked'
```

**Exact problem:** After `createBooking` → `markPaymentPending`, the unit is in `'payment_pending'` status (if the fix from Finding 1 is applied). When `confirmBooking` calls `markBooked`, the WHERE clause checks `status = 'locked'`, but the unit is `'payment_pending'`. The UPDATE matches 0 rows. The unit stays in `'payment_pending'` permanently.

Even WITHOUT the fix to Finding 1 (where markPaymentPending is a no-op), the unit stays in `'available'` and `markBooked` also fails (checks `status = 'locked'`).

**Real-world impact:**
- Unit shows as "held" to browsing customers instead of "booked"
- After 5 minutes, `lock_expires_at` expires → `reconcileStaleLocks` could release unit back to `'available'`
- A confirmed booking's unit becomes available → another customer books it → the unique index prevents double-confirm but the second customer wastes payment

**Concurrency impact:** HIGH — affects every confirmed booking.

**Data integrity impact:** Unit status diverges from booking status. Reconciliation workers may incorrectly release booked units.

**Recommended fix:**
```sql
UPDATE turf_availability_units SET status = 'booked' WHERE id = $1 AND status IN ('locked', 'payment_pending')
```

**Business-rule impact:** NONE — unit should correctly show as booked after payment.

**Launch blocker:** YES

---

#### FINDING 3: Settlement scheduled_at stored as literal text — never auto-schedules

**File:** `src/repositories/turfSettlementRepository.ts` (line 29, line 53)

**Current behavior:**
```typescript
// Line 29 (create method):
input.scheduled_at ?? 'NOW() + INTERVAL \'12 hours\''
// Line 53 (findOrCreatePendingSettlement):
VALUES ($1, "NOW() + INTERVAL '12 hours'")
```

**Exact problem:** PostgreSQL does NOT evaluate SQL expressions inside string literals. The string `'NOW() + INTERVAL \'12 hours\''` is stored as a TEXT VALUE in the `scheduled_at` column. When `findPendingByOrg` queries `WHERE scheduled_at <= NOW()`, it compares `NOW()` against a text string, which either:
- Errors with a type mismatch
- Or coerces the text to a timestamp (likely resulting in NULL or epoch)

**Real-world impact:** Settlements are NEVER automatically processed by `processDueSettlements()`. The `findPendingByOrg` query filters on `scheduled_at <= NOW()`, but `scheduled_at` contains text, not a real timestamp. All settlements queue forever.

**Concurrency impact:** CRITICAL — affects all payouts to venue owners.

**Data integrity impact:** All settlements stuck in 'pending' status indefinitely. Financial records incomplete.

**Recommended fix:**
```typescript
// In create method:
input.scheduled_at ?? () => `NOW() + INTERVAL '12 hours'`

// Better: compute the timestamp in TypeScript:
const scheduledAt = input.scheduled_at ?? new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
```

And change the column type or the query to handle it properly. Or use `CURRENT_TIMESTAMP + INTERVAL '12 hours'` as a computed column default in the migration.

**Business-rule impact:** NONE — settlements should auto-schedule at creation time + 12 hours.

**Launch blocker:** YES — payouts never process.

---

#### FINDING 4: releaseUnit markAvailable outside transaction — orphaned units

**File:** `src/services/turfAvailabilityEngine.ts` (line 895-927)

**Current behavior:**
```typescript
async releaseUnit(unitId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE turf_holds SET status = 'released' ...`);
    await client.query('COMMIT');
  } finally { client.release(); }
  // THIS IS OUTSIDE THE TRANSACTION:
  await turfAvailabilityRepository.markAvailable(unitId);
}
```

**Exact problem:** `markAvailable` runs AFTER the transaction commits and AFTER the client is released. If `markAvailable` fails (network error, connection lost), the hold record is released but the unit remains in its old state (`locked` or `payment_pending`). The unit is orphaned — no hold record references it, but it's not available for booking.

**Real-world impact:** Slots become permanently unavailable after hold release failures. Under high load, a significant percentage of slots could be orphaned.

**Concurrency impact:** MEDIUM — failure window is small but non-zero.

**Data integrity impact:** Orphaned units waste inventory.

**Recommended fix:** Move `markAvailable` inside the transaction:
```typescript
async releaseUnit(unitId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE turf_holds SET status = 'released', released_at = NOW() WHERE availability_unit_id = $1 AND status = 'active'`, [unitId]);
    await client.query(`UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1`, [unitId]);
    await client.query('COMMIT');
  } catch (err) { ... } finally { client.release(); }
}
```

**Business-rule impact:** NONE — unit should be available after hold release.

**Launch blocker:** YES — causes slot inventory loss under failure conditions.

---

### HIGH FINDINGS

---

#### FINDING 5: generateSlots transaction uses Pool instead of PoolClient (dead code)

**File:** `src/repositories/turfAvailabilityRepository.ts` (line 72-88)

**Current behavior:**
```typescript
const client = await getPool(); // Returns Pool, NOT PoolClient
await client.query('BEGIN');
// ... multiple INSERTs ...
await client.query('COMMIT');
```

**Exact problem:** `getPool()` returns a `Pool` object. `pool.query()` randomly picks a connection from the pool for EACH call. So `BEGIN` might run on connection A, INSERTs on connections B/C/D, and `COMMIT` on connection E. The transaction boundary is meaningless — partial commits are possible.

**Real-world impact:** Currently dead code (the service layer calls `turfAvailabilityService.generateSlots` which uses `pool.connect()` correctly). But if anyone calls the repository method directly, slot generation becomes non-atomic.

**Concurrency impact:** N/A — dead code.

**Data integrity impact:** N/A — dead code.

**Recommended fix:** Fix anyway for correctness:
```typescript
const client = await getPool().connect();
try {
  await client.query('BEGIN');
  // ... INSERTs on client ...
  await client.query('COMMIT');
} catch { ... } finally { client.release(); }
```

**Business-rule impact:** NONE — just fixes correctness of unused code.

**Launch blocker:** NO — dead code.

---

#### FINDING 6: IST/UTC offset arithmetic bug in repository generateSlots (dead code)

**File:** `src/repositories/turfAvailabilityRepository.ts` (line 60-68)

**Current behavior:**
```typescript
const start = new Date(Date.UTC(sy, sm - 1, sd, sh, smin, 0));
const end = new Date(Date.UTC(sy, sm - 1, sd, eh, emin, 0));
const IST_OFFSET = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
let cursor = new Date(start.getTime() + IST_OFFSET);
const endIST = new Date(end.getTime() + IST_OFFSET);
while (cursor < endIST) {
  const windowEnd = new Date(cursor.getTime() + slotDurationMinutes * 60000);
  if (windowEnd > endIST) break;
  slots.push({ startsAt: new Date(cursor.getTime() - IST_OFFSET), endsAt: new Date(windowEnd.getTime() - IST_OFFSET) });
  cursor = windowEnd;
}
```

**Exact problem:** The code adds IST_OFFSET then subtracts it. Net effect: `startsAt = start, endsAt = end`. The input times (from `Date.UTC`) are treated as UTC, not IST. If a venue wants slots starting at 6:00 AM IST, the stored `starts_at` would be 6:00 UTC (= 11:30 AM IST) — off by 5.5 hours.

**Real-world impact:** Dead code — the service layer's `buildSlotWindows` is correct and is the one in use.

**Recommended fix:** Remove the dead repository method entirely, or fix the offset math.

**Business-rule impact:** NONE — dead code.

**Launch blocker:** NO — dead code.

---

#### FINDING 7: Wallet balance race condition

**File:** `src/repositories/turfWalletRepository.ts` (line 17-23)

**Current behavior:**
```typescript
async getBalance(userId: number): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT COALESCE(SUM(coins), 0) as balance FROM turf_wallet_transactions WHERE user_id = $1',
    [userId]
  );
  return Number((rows[0] as any).balance) || 0;
}
```

**Exact problem:** `SUM(coins)` without a transaction or row lock. If two concurrent transactions insert wallet transactions for the same user, the SUM in each transaction's snapshot won't see the other's insert. Both transactions could compute the same balance, leading to incorrect `balance_after` values.

**Real-world impact:** Wallet balance display could show wrong values briefly. The `balance_after` column in individual transactions could be incorrect, making balance history unreliable.

**Concurrency impact:** MEDIUM — happens under concurrent bookings/rewards.

**Data integrity impact:** Wallet balance history is unreliable.

**Recommended fix:** Use a materialized balance column or compute balance within a serializable transaction:
```typescript
async getBalance(userId: number): Promise<number> {
  const { rows } = await getPool().query(
    'SELECT COALESCE(SUM(coins), 0) as balance FROM turf_wallet_transactions WHERE user_id = $1',
    [userId]
  );
  return Number((rows[0] as any).balance) || 0;
}
// Better: maintain a turf_wallet_balances table with row-level locking
```

**Business-rule impact:** NONE — just fixes balance calculation accuracy.

**Launch blocker:** NO — cosmetic for display, doesn't prevent bookings.

---

#### FINDING 8: State machine allows completed → cancelled — potential refund fraud

**File:** `src/services/turfStateMachine.ts` (line 23)

**Current behavior:**
```typescript
[TURF_BOOKING_STATES.COMPLETED]: ['cancelled'],
```

**Exact problem:** A booking that has reached `completed` status (user checked in, slot ended, worker called `completeBooking`) can be transitioned to `cancelled`. This is the only terminal state that allows reversal.

**Real-world impact:** A user who attended their slot could have their booking cancelled retroactively. If any refund logic is triggered by cancellation (even "NO CUSTOMER REFUND POLICY"), this creates an audit trail issue. More importantly, it violates the business rule that completed bookings are final.

**Concurrency impact:** LOW — requires admin or system action to trigger.

**Data integrity impact:** Completed bookings can be reverted, breaking audit trail.

**Recommended fix:**
```typescript
[TURF_BOOKING_STATES.COMPLETED]: [],  // Terminal — no transitions
```

**Business-rule impact:** NONE — enforces that completed bookings are truly final. This aligns with the existing "NO CUSTOMER REFUND POLICY" rule.

**Launch blocker:** NO — but should be fixed before production.

---

#### FINDING 9: No FOR UPDATE in availability repository methods

**File:** `src/repositories/turfAvailabilityRepository.ts` (lines 136-148)

**Current behavior:**
```typescript
async markBooked(unitId: number): Promise<void> {
  await getPool().query(
    "UPDATE turf_availability_units SET status = 'booked' WHERE id = $1 AND status = 'locked'",
    [unitId]
  );
}

async markAvailable(unitId: number): Promise<void> {
  await getPool().query(
    "UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1",
    [unitId]
  );
}
```

**Exact problem:** These UPDATEs don't use `FOR UPDATE` and don't check the expected source status. `markAvailable` transitions from ANY status to 'available' without checking what the current status is.

**Real-world impact:** If two reconciliation workers run concurrently, one could mark a unit 'available' while the other is processing it as 'locked'. The service layer's transaction wrapping provides some protection, but the repository methods themselves are not safe for standalone use.

**Recommended fix:** Add status guards:
```typescript
async markBooked(unitId: number): Promise<void> {
  await getPool().query(
    "UPDATE turf_availability_units SET status = 'booked' WHERE id = $1 AND status IN ('locked', 'payment_pending')",
    [unitId]
  );
}

async markAvailable(unitId: number): Promise<void> {
  await getPool().query(
    "UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1 AND status NOT IN ('booked')",
    [unitId]
  );
}
```

**Business-rule impact:** NONE — adds safety guards.

**Launch blocker:** NO — service layer transactions provide most protection.

---

### MEDIUM FINDINGS

---

#### FINDING 10: Worker Promise.all creates deadlock risk

**File:** `src/workers/turfWorkers.ts` (line 39-42)

**Current behavior:**
```typescript
const [expired, holds, locks] = await Promise.all([
  turfExpireStaleBookings(),     // uses FOR UPDATE on turf_bookings + updates turf_availability_units
  turfExpireStaleHolds(),        // uses FOR UPDATE on turf_holds + updates turf_availability_units
  turfReconcileStaleLocks(),     // uses FOR UPDATE on turf_holds + turf_availability_units
]);
```

**Exact problem:** `expireStaleHolds` and `reconcileStaleLocks` both acquire `SELECT ... FOR UPDATE` on `turf_holds` within their own transactions. If both workers process overlapping rows, PostgreSQL will deadlock (Transaction A holds lock on row X and waits for Y; Transaction B holds lock on row Y and waits for X).

**Real-world impact:** Worker crashes with deadlock errors under load. Some stale holds/locks not cleaned up.

**Concurrency impact:** MEDIUM — probability increases with number of stale holds.

**Recommended fix:** Run sequentially or use advisory locks:
```typescript
const expired = await turfExpireStaleBookings();
const holds = await turfExpireStaleHolds();
const locks = await turfReconcileStaleLocks();
```

**Business-rule impact:** NONE — just changes execution order.

**Launch blocker:** NO — sequential execution is safer and only marginally slower.

---

#### FINDING 11: Coupon incrementUsage has no usage_limit guard

**File:** `src/repositories/turfCouponRepository.ts` (line 38-40)

**Current behavior:**
```typescript
async incrementUsage(id: number): Promise<void> {
  await getPool().query('UPDATE turf_coupons SET used_count = used_count + 1 WHERE id = $1', [id]);
}
```

**Exact problem:** No `WHERE used_count < usage_limit` guard. If two concurrent bookings use the last coupon, both pass the pre-check (`used_count < usage_limit`) and both increment. Result: `used_count` exceeds `usage_limit` by the number of concurrent requests.

**Real-world impact:** Coupon overuse by 1-2 extra redemptions under concurrent load. Minor financial impact.

**Mitigation:** The booking service checks `coupon.used_count >= coupon.usage_limit` inside the transaction BEFORE calling `incrementUsage`. This reduces the race window. But if `incrementUsage` is called from any other path, the guard is missing.

**Recommended fix:**
```typescript
async incrementUsage(id: number): Promise<void> {
  await getPool().query(
    'UPDATE turf_coupons SET used_count = used_count + 1 WHERE id = $1 AND (usage_limit IS NULL OR used_count < usage_limit)',
    [id]
  );
}
```

**Business-rule impact:** NONE — enforces existing usage_limit rule.

**Launch blocker:** NO — mitigated by booking service transaction.

---

#### FINDING 12: Settlement create/findOrCreatePendingSettlement uses literal SQL

**File:** `src/repositories/turfSettlementRepository.ts` (line 29, line 53)

**Current behavior:** Same as Finding 3 — `'NOW() + INTERVAL \'12 hours\''` is stored as text.

**Real-world impact:** Same as Finding 3 — settlements never auto-schedule.

**Recommended fix:** Same as Finding 3 — compute timestamp in TypeScript.

**Business-rule impact:** NONE.

**Launch blocker:** YES (same root cause as Finding 3).

---

#### FINDING 13: No idempotency on refund creation

**File:** `src/repositories/turfRefundRepository.ts`

**Exact problem:** No deduplication mechanism. If a refund request is retried (network timeout, client retry), multiple refund records could be created for the same booking. No unique constraint on `(booking_id)` or idempotency key.

**Real-world impact:** Duplicate refunds under retry scenarios. Financial loss.

**Recommended fix:** Add unique constraint on `(booking_id)` or add an idempotency_key column.

**Business-rule impact:** NONE — prevents duplicate refunds, aligns with "NO CUSTOMER REFUND POLICY".

**Launch blocker:** NO — low probability, easy fix.

---

#### FINDING 14: No unique constraint on turf_qr_tickets(booking_id)

**File:** Migration `022_turf_domain.sql`

**Exact problem:** The `turf_qr_tickets` table has no unique constraint on `booking_id`. The repository's `findByBooking` returns a single row but the DB allows multiple QR tickets per booking. If `_generateQRTicket` is called twice for the same booking, two QR records are created.

**Real-world impact:** Duplicate QR tickets. Both could be scanned for check-in. The `markUsed` update only marks one as used.

**Recommended fix:** Add `CREATE UNIQUE INDEX uq_turf_qr_tickets_booking ON turf_qr_tickets(booking_id)`.

**Business-rule impact:** NONE — one ticket per booking.

**Launch blocker:** NO — _generateQRTicket is only called once per booking in the current flow.

---

#### FINDING 15: _awardCoins balance_after hardcoded to 0

**File:** `src/services/turfBookingService.ts` (line 779)

**Current behavior:**
```typescript
turfWalletRepository.create({
  ...
  balance_after: 0,  // Always 0!
})
```

**Exact problem:** Every wallet transaction records `balance_after: 0`. This makes the wallet balance history meaningless. If anyone queries the wallet statement, every transaction shows zero balance.

**Real-world impact:** Wallet transaction history is incorrect. Balance display that relies on `balance_after` shows wrong values.

**Recommended fix:** Compute actual balance:
```typescript
const currentBalance = await turfWalletRepository.getBalance(userId);
const newBalance = currentBalance + coins;
turfWalletRepository.create({ ..., balance_after: newBalance });
```

**Business-rule impact:** NONE — just fixes data accuracy.

**Launch blocker:** NO — cosmetic for wallet history.

---

#### FINDING 16: _createSettlement reverse-calculation hardcodes ₹50 + 18% GST

**File:** `src/services/turfBookingService.ts` (line 743), `src/services/turfSettlementService.ts` (line 36)

**Current behavior:**
```typescript
grossAmountPaise = Math.round((grossAmount * 100 - 5000) / 1.18);
```

**Exact problem:** The fallback formula assumes:
- Platform fee is always ₹50 (5000 paise)
- GST is always 18% (÷ 1.18)

If the financial config changes (different platform fee or GST rate), the fallback calculation produces wrong settlement amounts. The primary path (reading from `pricingSnapshot.subtotalPaise`) is correct, but if the snapshot is missing, the fallback is wrong.

**Real-world impact:** Incorrect commission/TDS/net calculations for settlements when pricingSnapshot is absent.

**Recommended fix:** Store `subtotalPaise` as a required field in booking metadata, or read it from the pricing engine at settlement time.

**Business-rule impact:** NONE — just ensures financial accuracy.

**Launch blocker:** NO — primary path (pricingSnapshot) is used for confirmed bookings.

---

#### FINDING 17: cleanupOldAvailability could delete yesterday's available slots

**File:** `src/services/turfAvailabilityGenerator.ts` (line 278-283)

**Current behavior:**
```sql
DELETE FROM turf_availability_units
WHERE starts_at < $1::date
  AND status NOT IN ('booked', 'held', 'payment_pending')
```

**Exact problem:** The `NOT IN` list excludes `'booked'`, `'held'`, `'payment_pending'` but does NOT exclude `'confirmed'` bookings (that's a booking status, not a unit status). More importantly, units with status `'available'` from yesterday that haven't been booked are DELETED. If a customer had a slot from yesterday still in 'available' state (unlikely but possible if generation failed), it's deleted.

**Real-world impact:** Minimal — yesterday's slots should not be bookable anyway. But if a slot was just generated and then the date crossed midnight, it could be immediately cleaned up.

**Recommended fix:** Change to:
```sql
WHERE starts_at < $1::date
  AND status NOT IN ('booked', 'held', 'payment_pending', 'available')
```

Or better, only delete `'available'` and `'blocked'` statuses:
```sql
WHERE starts_at < $1::date
  AND status IN ('available', 'blocked', 'unavailable')
```

**Business-rule impact:** NONE — prevents accidental deletion of in-progress slots.

**Launch blocker:** NO — edge case.

---

### LOW FINDINGS

---

#### FINDING 18: reclaimExpiredLocks duplicated across service and repository

**File:** `src/services/turfAvailabilityService.ts` (line 63-70), `src/repositories/turfAvailabilityRepository.ts` (line 34-41)

**Exact problem:** `reclaimExpiredLocks` exists in both the service and repository with identical SQL. The repository version (`reclaimExpiredLocksForUnit` in the repository) is also duplicated with a different name. Maintenance burden — if the SQL changes, both need updating.

**Recommended fix:** Remove one copy.

**Launch blocker:** NO.

---

#### FINDING 19: incrementVersion is dead code

**File:** `src/repositories/turfBookingRepository.ts` (line 174-176)

**Exact problem:** `incrementVersion` is defined but never called anywhere. The `version` column exists in the schema but has no trigger enforcing optimistic locking.

**Recommended fix:** Either add optimistic locking checks using `version`, or remove the column and method.

**Launch blocker:** NO.

---

#### FINDING 20: updateStatus accepts arbitrary column names

**File:** `src/repositories/turfBookingRepository.ts` (line 145-160)

**Exact problem:**
```typescript
for (const [key, value] of Object.entries(extra)) {
  setClauses.push(`${key} = $${idx++}`);
  params.push(value);
}
```

No whitelist — any key in the `extra` object becomes a SET clause. If a caller passes a malicious or typo'd key, it could set unintended columns.

**Recommended fix:** Add a whitelist:
```typescript
const ALLOWED_EXTRA = new Set(['payment_status', 'payment_gateway_ref', 'cancellation_reason', 'cancelled_by', 'cancellation_fee', 'notes']);
for (const [key, value] of Object.entries(extra)) {
  if (!ALLOWED_EXTRA.has(key)) continue;
  ...
}
```

**Launch blocker:** NO — all callers are internal and trusted.

---

#### FINDING 21: No rate limiting on write endpoints

**File:** `src/routes/turfRoutes.ts`, `src/routes/turfOrganizerRoutes.ts`, `src/routes/turfManagerRoutes.ts`, `src/routes/turfPaymentRoutes.ts`

**Current behavior:** Only `POST /bookings` has rate limiting (`bookingRateLimiter`). Cancellations, check-ins, reviews, organizer CRUD, manager operations, and payment operations have no rate limits.

**Recommended fix:** Add rate limiting middleware to write endpoints.

**Launch blocker:** NO — moderate risk, not immediate.

---

#### FINDING 22: Offline booking auto-creates users from phone

**File:** `src/routes/turfManagerRoutes.ts`

**Exact problem:** Manager can create a booking for a customer identified only by phone number. The system auto-creates a user account with no email verification. The customer never receives login credentials.

**Real-world impact:** Orphaned user accounts. Customer can't access their booking history online.

**Recommended fix:** Send OTP to phone for account activation, or require email collection.

**Launch blocker:** NO — existing business behavior.

---

## SECTION C: SUMMARY TABLE

| # | Severity | Finding | File | Launch Blocker |
|---|----------|---------|------|----------------|
| 1 | CRITICAL | No booking lock in createBooking — double-booking | turfBookingService.ts + turfAvailabilityRepository.ts | YES |
| 2 | CRITICAL | markBooked checks wrong status — unit stuck in payment_pending | turfAvailabilityRepository.ts | YES |
| 3 | CRITICAL | Settlement scheduled_at as literal text — never processes | turfSettlementRepository.ts | YES |
| 4 | CRITICAL | releaseUnit markAvailable outside transaction — orphaned units | turfAvailabilityEngine.ts | YES |
| 5 | HIGH | generateSlots transaction uses Pool (dead code) | turfAvailabilityRepository.ts | NO |
| 6 | HIGH | IST/UTC offset bug in generateSlots (dead code) | turfAvailabilityRepository.ts | NO |
| 7 | HIGH | Wallet balance race condition | turfWalletRepository.ts | NO |
| 8 | HIGH | State machine allows completed → cancelled | turfStateMachine.ts | NO |
| 9 | HIGH | No FOR UPDATE / status guards in repository | turfAvailabilityRepository.ts | NO |
| 10 | MEDIUM | Worker Promise.all deadlock risk | turfWorkers.ts | NO |
| 11 | MEDIUM | Coupon incrementUsage no usage_limit guard | turfCouponRepository.ts | NO |
| 12 | MEDIUM | findOrCreatePendingSettlement literal SQL | turfSettlementRepository.ts | NO (same as #3) |
| 13 | MEDIUM | No idempotency on refund creation | turfRefundRepository.ts | NO |
| 14 | MEDIUM | No unique constraint on QR tickets per booking | Migration 022 | NO |
| 15 | MEDIUM | _awardCoins balance_after hardcoded to 0 | turfBookingService.ts | NO |
| 16 | MEDIUM | Settlement reverse-calculation hardcodes pricing | turfBookingService.ts | NO |
| 17 | MEDIUM | cleanupOldAvailability could delete in-progress slots | turfAvailabilityGenerator.ts | NO |
| 18 | LOW | reclaimExpiredLocks duplicated | Service + Repository | NO |
| 19 | LOW | incrementVersion dead code | turfBookingRepository.ts | NO |
| 20 | LOW | updateStatus accepts arbitrary columns | turfBookingRepository.ts | NO |
| 21 | LOW | No rate limiting on write endpoints | Routes | NO |
| 22 | LOW | Offline booking auto-creates users | turfManagerRoutes.ts | NO |

---

## SECTION D: WHAT'S WORKING WELL

1. **Partial unique index for concurrency control** — `uq_turf_booking_au_confirmed` correctly prevents double-confirmed bookings.
2. **Hold system with DB-backed uniqueness** — `uq_turf_hold_active_unit` prevents concurrent holds.
3. **FOR UPDATE in booking creation** — Row-level locking prevents most race conditions.
4. **ON CONFLICT DO NOTHING for slot generation** — Idempotent by design.
5. **Connection pool TIME ZONE setting** — Ensures consistent IST timestamps.
6. **SELECT FOR UPDATE in expireStaleHolds** — Prevents race with confirmHold.
7. **Idempotency cache with Redis fallback** — Falls through to DB transaction if Redis is down.
8. **PricingEngine for financial calculations** — Centralized, uses paise for precision.
9. **QR ticket signing** — Cryptographic signature prevents forgery.
10. **Audit logging** — `turf_booking_audits` records all state transitions.
11. **Admin auth middleware** — is_active check + permissions freshness.
12. **Organizer auth middleware** — Separate key-space, active check.

---

## SECTION E: BUGS THAT ARE NOT BUGS (False Positives from Agents)

1. **"IST/UTC offset bug"** — Only exists in dead code (repository.generateSlots). Service layer is correct.
2. **"releaseUnit race condition"** — Real but only affects the hold flow, not the booking flow. Service layer transactions protect the booking path.
3. **"No FOR UPDATE anywhere"** — False — booking creation, hold acquisition, worker expireStaleHolds, reconcileStaleLocks all use FOR UPDATE correctly.
4. **"Worker concurrent execution risk"** — Real but low probability. Sequential execution fixes it.
5. **"Coupon usage overshoot"** — Mitigated by in-transaction pre-check in createBooking.

---

## SECTION F: CRITICAL PATH SUMMARY

The 4 CRITICAL findings form a chain:

```
FINDING 1: Unit stays 'available' during booking
    ↓
FINDING 2: markBooked fails (checks 'locked' but unit is 'payment_pending')
    ↓
FINDING 3: Settlements never schedule (literal text in scheduled_at)
    ↓
FINDING 4: Hold release can orphan units
```

These are all in the **booking → payment → settlement** critical path. Fixing Findings 1 and 2 together resolves the double-booking and unit-status issues. Fixing Finding 3 enables payout processing. Fixing Finding 4 prevents inventory loss.

**Next step:** Proceed to Phase 3 (fix confirmed bugs) with these 4 critical fixes as priority.
