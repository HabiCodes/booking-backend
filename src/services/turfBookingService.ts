/**
 * Turf Booking Service — core booking engine with Redis locking, idempotency, and payment expiry worker.
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';
import { getRedis } from '../db/redis';
import crypto from 'crypto';
import { assertTransition, TURF_BOOKING_STATES } from './turfStateMachine';
import { turfAvailabilityRepository } from '../repositories/turfAvailabilityRepository';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfQRRepository } from '../repositories/turfQRRepository';
import { turfCouponRepository } from '../repositories/turfCouponRepository';
import { turfSettlementRepository } from '../repositories/turfSettlementRepository';
import { turfRefundRepository } from '../repositories/turfRefundRepository';
import { turfWalletRepository } from '../repositories/turfWalletRepository';
import { turfVenueRepository } from '../repositories/turfVenueRepository';
import { turfResourceRepository } from '../repositories/turfResourceRepository';
import { turfReviewRepository } from '../repositories/turfReviewRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { availabilityEngine } from './turfAvailabilityEngine';
import { financialConfigService } from './financialConfigService';
import { calculateBookingFinancials } from './financialCalculator';

const CORRELATION_PREFIX = 'turf_booking';
const MAX_QUANTITY = 10;
const PAYMENT_TIMEOUT_SECONDS = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateCorrelationId(): string {
  return `${CORRELATION_PREFIX}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateBookingReference(): string {
  return `TF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function generateIdempotencyKey(userId: number, unitId: number): string {
  return `turf_booking_${userId}_unit_${unitId}`;
}

async function audit(bookingId: number, action: string, extra: Record<string, unknown> = {}) {
  try {
    await getPool().query(
      `INSERT INTO turf_booking_audits (booking_id, ticket_id, actor_type, actor_id, action, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
      [bookingId, extra.ticketId ?? null, extra.actorType ?? 'system', extra.actorId ?? null, action, { ...extra, timestamp: new Date().toISOString() }]
    );
  } catch (err) {
    logger.error(`[TurfAudit] Failed for ${action}:`, err);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class TurfBookingService {

  /**
   * Create a new Turf booking with idempotency and coupon support.
   */
  async createBooking(userId: number, input: {
    availability_unit_id: number;
    quantity?: number;
    booking_type?: 'online' | 'offline' | 'complimentary';
    coupon_code?: string | null;
  }, actor: { actorId: number; actorType: string }) {
    const unitId = input.availability_unit_id;
    const quantity = Math.min(Math.max(input.quantity ?? 1, 1), MAX_QUANTITY);

    // ── Idempotency Check ────────────────────────────────────────────────────
    const idempotencyKey = generateIdempotencyKey(userId, unitId);
    const redis = getRedis();
    const cached = await redis.get(`turf:idempotency:${idempotencyKey}`);
    if (cached) {
      const data = JSON.parse(cached);
      const existing = await turfBookingRepository.findById(data.bookingId);
      if (existing && existing.status === 'pending_payment') {
        throw new AppError('Booking already in progress', 409);
      }
      if (existing) {
        return { booking: existing, couponDiscount: 0, correlationId: '', idempotent: true };
      }
    }

    const pool = getPool();
    const client = await pool.connect();
    const correlationId = generateCorrelationId();

    try {
      await client.query('BEGIN');

      const unitRow = await client.query('SELECT * FROM turf_availability_units WHERE id = $1 FOR UPDATE', [unitId]);
      const unit = unitRow.rows[0];
      if (!unit) {
        await client.query('ROLLBACK');
        throw new AppError('Slot not found', 404);
      }
      if (unit.status !== 'available') {
        await client.query('ROLLBACK');
        throw new AppError('Slot no longer available', 409);
      }

      const resource = await turfResourceRepository.findById(unit.resource_id);
      if (!resource) {
        await client.query('ROLLBACK');
        throw new AppError('Resource not found', 404);
      }

      const venue = await turfVenueRepository.findById(resource.venue_id);
      if (!venue || venue.status !== 'approved') {
        await client.query('ROLLBACK');
        throw new AppError('Venue not available', 400);
      }

      const orgResult = await client.query('SELECT id, is_active FROM organizations WHERE id = $1', [venue.organization_id]);
      const org = orgResult.rows[0];
      if (!org || !org.is_active) {
        await client.query('ROLLBACK');
        throw new AppError('Organization not active', 400);
      }

      const slotStartMs = new Date(unit.starts_at).getTime();
      const slotEndMs = new Date(unit.ends_at).getTime();
      const slotDurationMs = slotEndMs - slotStartMs;
      if (slotDurationMs > 4 * 60 * 60 * 1000) {
        await client.query('ROLLBACK');
        throw new AppError('Maximum booking duration is 4 hours', 400);
      }

      const overlapResult = await client.query(
        `SELECT b.id FROM turf_bookings b
         JOIN turf_availability_units au ON b.availability_unit_id = au.id
         WHERE b.user_id = $1
           AND b.status NOT IN ('cancelled', 'refunded', 'expired')
           AND au.starts_at < $3
           AND au.ends_at > $2`,
        [userId, unit.starts_at, unit.ends_at]
      );
      if (overlapResult.rows.length) {
        await client.query('ROLLBACK');
        throw new AppError('You already have a booking during this time', 409);
      }

      // ── Coupon Validation ─────────────────────────────────────────────────
      let discountAmount = 0;
      let couponUsageId: number | null = null;
      if (input.coupon_code) {
        const coupon = await turfCouponRepository.findByCode(venue.organization_id, input.coupon_code);
        if (!coupon) {
          await client.query('ROLLBACK');
          throw new AppError('Invalid coupon code', 400);
        }
        if (!coupon.is_active) {
          await client.query('ROLLBACK');
          throw new AppError('Coupon is not active', 400);
        }
        if (new Date() > new Date(coupon.valid_until)) {
          await client.query('ROLLBACK');
          throw new AppError('Coupon has expired', 400);
        }
        const basePrice = parseFloat(unit.price ?? resource.base_price) * quantity;
        if (parseFloat(coupon.min_booking_amount as string) > basePrice) {
          await client.query('ROLLBACK');
          throw new AppError(`Minimum booking amount required`, 400);
        }
        if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
          await client.query('ROLLBACK');
          throw new AppError('Coupon usage limit reached', 400);
        }

        const usages = await turfCouponRepository.findUsageByUserAndCoupon(userId, coupon.id);
        if (usages.length >= coupon.per_user_limit) {
          await client.query('ROLLBACK');
          throw new AppError('You have already used this coupon', 400);
        }

        if (coupon.discount_type === 'percentage') {
          discountAmount = Math.round((basePrice * parseFloat(coupon.discount_value as string)) / 100 * 100) / 100;
          if (coupon.max_discount) discountAmount = Math.min(discountAmount, parseFloat(coupon.max_discount as string));
        } else {
          discountAmount = parseFloat(coupon.discount_value as string);
        }

        const usage = await turfCouponRepository.createUsage({
          coupon_id: coupon.id,
          booking_id: 0,
          user_id: userId,
          discount_amount: discountAmount,
        });
        couponUsageId = usage.id;
        await turfCouponRepository.incrementUsage(coupon.id);
      }

      const finalAmount = Math.round(((parseFloat(unit.price ?? resource.base_price) * quantity) - discountAmount) * 100) / 100;

      // ── Insert Booking ────────────────────────────────────────────────────
      const bookingRef = generateBookingReference();
      const bookingResult = await client.query(
        `INSERT INTO turf_bookings
         (booking_reference, user_id, organization_id, venue_id, resource_id, availability_unit_id,
          booking_type, quantity, amount, status, payment_status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_payment','initiated',$10::jsonb)
         RETURNING *`,
        [bookingRef, userId, venue.organization_id, venue.id, resource.id, unit.id,
         input.booking_type ?? 'online', quantity, finalAmount,
         JSON.stringify({ correlationId, discountAmount, couponCode: input.coupon_code ?? null, idempotencyKey })]
      );
      const booking = bookingResult.rows[0];

      // Update coupon usage with actual booking_id
      if (couponUsageId) {
        await getPool().query(
          'UPDATE turf_coupon_usages SET booking_id = $1 WHERE id = $2',
          [booking.id, couponUsageId]
        );
      }

      await turfAvailabilityRepository.markPaymentPending(unit.id, userId);

      await client.query('COMMIT');

      // ── Post-Commit: Idempotency Cache ────────────────────────────────────
      await redis.set(`turf:idempotency:${idempotencyKey}`, JSON.stringify({
        bookingId: booking.id,
        status: 'pending_payment',
      }), 'EX', PAYMENT_TIMEOUT_SECONDS + 60);

      await audit(booking.id, 'booking.created', {
        actorId: actor.actorId, actorType: actor.actorType,
        details: { amount: finalAmount, unitId, resourceId: resource.id, venueId: venue.id, correlationId },
      });

      logger.info(`[TurfBooking] Created: ${booking.booking_reference}, amount: ${finalAmount}`);

      return {
        booking: { ...booking, amount: finalAmount },
        couponDiscount: discountAmount,
        correlationId,
      };

    } catch (err) {
      await client.query('ROLLBACK');
      await redis.del(`turf:idempotency:${idempotencyKey}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Confirm a Turf booking after successful payment.
   */
  async confirmBooking(bookingId: number, actor: { actorId: number; actorType: string }) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const bookingResult = await client.query('SELECT * FROM turf_bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      const booking = bookingResult.rows[0];
      if (!booking) {
        await client.query('ROLLBACK');
        throw new AppError('Booking not found', 404);
      }

      assertTransition(booking.status, TURF_BOOKING_STATES.CONFIRMED);
      if (booking.status !== 'pending_payment') {
        await client.query('COMMIT');
        return booking;
      }

      // Verify payment is captured
      const paymentOrder = await paymentOrderRepository.findByBookingId(bookingId);
      if (!paymentOrder) {
        await client.query('ROLLBACK');
        throw new AppError('Payment not initiated for this booking', 409);
      }
      if (paymentOrder.status !== 'COMPLETED') {
        await client.query('ROLLBACK');
        throw new AppError('Payment not confirmed for this booking', 409);
      }

      await turfAvailabilityRepository.markBooked(booking.availability_unit_id);

      // Release coupon reservation
      const meta = booking.metadata || {};
      if (meta.couponCode) {
        await client.query(
          "UPDATE turf_coupon_usages SET status = 'redeemed', updated_at = NOW() WHERE booking_id = $1 AND status = 'reserved'",
          [bookingId]
        );
      }

      // NOTE: turf_holds lifecycle is managed by the AvailabilityEngine
      // (acquireHold / releaseHold / confirmHold).  The booking flow
      // does NOT create turf_holds records — it marks the unit directly
      // via markBooked().  A future "hold-then-pay" flow will use holds.

      const updated = await turfBookingRepository.updateStatus(bookingId, 'confirmed', {
        payment_status: 'captured',
        payment_gateway_ref: paymentOrder.cf_payment_id || undefined,
      });

      await client.query('COMMIT');

      // ── Post-Commit: QR Generation ────────────────────────────────────────
      const qrToken = await this._generateQRTicket(booking);

      // ── Post-Commit: Settlement ───────────────────────────────────────────
      await this._createSettlement(booking.id, booking.organization_id, parseFloat(booking.amount));

      // ── Post-Commit: Wallet Coins ─────────────────────────────────────────
      this._awardCoins(booking.user_id, booking.organization_id, parseFloat(booking.amount), booking.id);

      await audit(bookingId, 'booking.confirmed', {
        actorId: actor.actorId, actorType: actor.actorType,
        details: { status: 'confirmed', qrToken },
      });

      logger.info(`[TurfBooking] Confirmed: ${booking.booking_reference}`);
      return { ...updated, qr_token: qrToken };

    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`[TurfBooking] Confirm failed for ${bookingId}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cancel a Turf booking.
   */
  async cancelBooking(bookingId: number, userId: number, reason: string | null, actor: { actorId: number; actorType: string }) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const bookingResult = await client.query(
        `SELECT b.*, au.starts_at FROM turf_bookings b
         JOIN turf_availability_units au ON b.availability_unit_id = au.id
         WHERE b.id = $1 FOR UPDATE`,
        [bookingId]
      );
      const booking = bookingResult.rows[0];
      if (!booking) {
        await client.query('ROLLBACK');
        throw new AppError('Booking not found', 404);
      }

      assertTransition(booking.status, TURF_BOOKING_STATES.CANCELLED);

      const slotStart = new Date(booking.starts_at);
      const hoursUntilSlot = (slotStart.getTime() - Date.now()) / (1000 * 60 * 60);

      if (hoursUntilSlot < 2) {
        await client.query('ROLLBACK');
        throw new AppError('Cancellation allowed only 2 hours before slot', 409);
      }

      const refundEligible = hoursUntilSlot >= 24;
      const newStatus = refundEligible ? 'refunded' : 'cancelled';

      await turfAvailabilityRepository.markAvailable(booking.availability_unit_id);
      await turfQRRepository.revokeByBooking(bookingId);

      // Release coupon reservation + decrement used_count
      await client.query(
        "UPDATE turf_coupon_usages SET status = 'released', updated_at = NOW() WHERE booking_id = $1 AND status = 'reserved'",
        [bookingId]
      );
      await client.query(
        'UPDATE turf_coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id IN (SELECT coupon_id FROM turf_coupon_usages WHERE booking_id = $1 AND status = \'released\')',
        [bookingId]
      );

      const cancelled = await turfBookingRepository.updateStatus(bookingId, newStatus, {
        cancellation_reason: reason,
        cancelled_by: actor.actorType,
      });

      await client.query('COMMIT');

      if (['confirmed', 'checked_in'].includes(booking.status)) {
        turfWalletRepository.create({
          user_id: booking.user_id,
          organization_id: booking.organization_id,
          coins: -Math.floor(parseFloat(booking.amount)),
          balance_after: 0,
          type: 'cancellation_penalty',
          category: 'cancellation',
          booking_id: bookingId,
          description: 'Coins reversed due to cancellation',
          actor_type: 'system',
        }).catch(err => logger.error(`[TurfWallet] Reverse failed:`, err));
      }

      if (refundEligible) {
        await this._processRefund(bookingId, parseFloat(booking.amount), reason);
      }

      await audit(bookingId, 'booking.cancelled', {
        actorId: actor.actorId, actorType: actor.actorType,
        details: { oldStatus: booking.status, newStatus, refundEligible, reason },
      });

      logger.info(`[TurfBooking] Cancelled: ${booking.booking_reference} → ${newStatus}`);
      return cancelled;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`[TurfBooking] Cancel failed for ${bookingId}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Customer self check-in — confirms the booking is theirs and transitions.
   */
  async checkIn(bookingId: number, actor: { actorId: number; actorType: string }) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const booking = await turfBookingRepository.findById(bookingId);
      if (!booking) {
        await client.query('ROLLBACK');
        throw new AppError('Booking not found', 404);
      }

      assertTransition(booking.status, TURF_BOOKING_STATES.CHECKED_IN);
      if (booking.status !== 'confirmed') {
        await client.query('ROLLBACK');
        throw new AppError(`Cannot check in: booking is ${booking.status}`, 409);
      }

      const updated = await turfBookingRepository.updateStatus(bookingId, 'checked_in');

      await client.query('COMMIT');

      await audit(bookingId, 'booking.checked_in', { actorId: actor.actorId, actorType: actor.actorType });
      logger.info(`[TurfBooking] Checked in: ${booking.booking_reference}`);
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Manager check-in with QR token validation.
   */
  async checkInBooking(bookingId: number, qrToken: string, actor: { actorId: number; actorType: string }) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const booking = await turfBookingRepository.findById(bookingId);
      if (!booking) {
        await client.query('ROLLBACK');
        throw new AppError('Booking not found', 404);
      }

      assertTransition(booking.status, TURF_BOOKING_STATES.CHECKED_IN);
      if (booking.status !== 'confirmed') {
        await client.query('ROLLBACK');
        throw new AppError(`Cannot check in: booking is ${booking.status}`, 409);
      }

      const qr = await turfQRRepository.findByToken(qrToken);
      if (!qr) {
        await client.query('ROLLBACK');
        throw new AppError('QR ticket not found', 404);
      }
      if (qr.status === 'used') {
        await client.query('ROLLBACK');
        throw new AppError('QR already used', 409);
      }
      if (qr.status === 'revoked') {
        await client.query('ROLLBACK');
        throw new AppError('QR ticket revoked', 409);
      }
      if (qr.booking_id !== bookingId) {
        await client.query('ROLLBACK');
        throw new AppError('QR does not match this booking', 409);
      }

      const updated = await turfBookingRepository.updateStatus(bookingId, 'checked_in');
      await turfQRRepository.markUsed(qr.id, actor.actorId);

      await client.query('COMMIT');

      await audit(bookingId, 'booking.checked_in', { actorId: actor.actorId, actorType: actor.actorType });
      logger.info(`[TurfBooking] Checked in: ${booking.booking_reference}`);
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Complete a booking (called by worker when slot ends).
   */
  async completeBooking(bookingId: number) {
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking || booking.status !== 'checked_in') return null;

    const updated = await turfBookingRepository.updateStatus(bookingId, 'completed');

    await this._createSettlement(booking.id, booking.organization_id, parseFloat(booking.amount));

    await audit(bookingId, 'booking.completed', { actorType: 'worker' });
    logger.info(`[TurfBooking] Completed: ${booking.booking_reference}`);
    return updated;
  }

  /**
   * Create a review for a completed/checked-in booking.
   */
  async createReview(userId: number, venueId: number, bookingId: number, rating: number, reviewText: string | null) {
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    if (!['confirmed', 'completed', 'checked_in'].includes(booking.status)) {
      throw new AppError('Can only review after confirmed booking', 400);
    }

    // Check for existing review by this user for this venue
    const existingReviews = await turfReviewRepository.findByVenue(venueId);
    const alreadyReviewed = existingReviews.find(r => r.booking_id === bookingId && r.user_id === userId);
    if (alreadyReviewed) throw new AppError('You have already reviewed this booking', 409);

    return turfReviewRepository.create({
      venue_id: venueId,
      user_id: userId,
      booking_id: bookingId,
      rating: Math.min(5, Math.max(1, rating)),
      review: reviewText,
    });
  }

  /**
   * Worker: expire stale pending_payment bookings.
   */
  async expireStaleBookings() {
    const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_SECONDS * 1000).toISOString();
    const { rows } = await getPool().query(
      `SELECT id FROM turf_bookings
       WHERE status = 'pending_payment' AND created_at < $1 AND deleted_at IS NULL`,
      [cutoff]
    );

    let expiredCount = 0;
    for (const row of rows) {
      try {
        const booking = await turfBookingRepository.findById(row.id);
        if (!booking || booking.status !== 'pending_payment') continue;

        const client = await getPool().connect();
        try {
          await client.query('BEGIN');
          await turfAvailabilityRepository.markAvailable(booking.availability_unit_id);

          await client.query(
            "UPDATE turf_coupon_usages SET status = 'released', updated_at = NOW() WHERE booking_id = $1 AND status = 'reserved'",
            [booking.id]
          );
          await client.query(
            'UPDATE turf_coupons SET used_count = GREATEST(used_count - 1, 0) WHERE id IN (SELECT coupon_id FROM turf_coupon_usages WHERE booking_id = $1 AND status = \'released\')',
            [booking.id]
          );

          await turfBookingRepository.updateStatus(booking.id, 'expired');
          await client.query('COMMIT');

          await audit(booking.id, 'booking.expired', { actorType: 'worker', reason: 'Payment timeout' });
          expiredCount++;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        logger.error(`[TurfWorker] Failed to expire booking ${row.id}:`, err);
      }
    }

    if (expiredCount > 0) logger.info(`[TurfWorker] Expired ${expiredCount} stale bookings`);
    return expiredCount;
  }

  /**
   * Worker: complete checked_in bookings whose slots have ended.
   */
  async completeEndedSlots() {
    const { rows } = await getPool().query(
      `SELECT b.id FROM turf_bookings b
       JOIN turf_availability_units au ON b.availability_unit_id = au.id
       WHERE b.status = 'checked_in' AND au.ends_at < NOW()`
    );

    let completedCount = 0;
    for (const row of rows) {
      try {
        const result = await this.completeBooking(row.id);
        if (result) completedCount++;
      } catch (err) {
        logger.error(`[TurfWorker] Failed to complete booking ${row.id}:`, err);
      }
    }

    if (completedCount > 0) logger.info(`[TurfWorker] Completed ${completedCount} bookings via slot end`);
    return completedCount;
  }

  // ── Private: QR Generation ─────────────────────────────────────────────────

  private async _generateQRTicket(booking: any): Promise<string> {
    const randomBytes = crypto.randomBytes(16);
    const token = `${Date.now().toString(36)}${randomBytes.toString('base64url').slice(0, 22)}`;
    const qrTicket = await turfQRRepository.create(booking.id, token);

    const { signTicket } = await import('../utils/qrCode');
    const slotStart = (booking.metadata && (booking.metadata as any).slot_start) || new Date().toISOString();
    const signature = signTicket(
      { ticket_uuid: `turf_${token}` },
      booking.venue_id,
      slotStart
    );

    await getPool().query(
      'UPDATE turf_qr_tickets SET metadata = $1 WHERE id = $2',
      [JSON.stringify({ signature, signed_at: new Date().toISOString() }), qrTicket.id]
    );

    return token;
  }

  // ── Private: Settlement ────────────────────────────────────────────────────
  // All financial rates come from financialConfigService via FinancialCalculator.
  // Commission: financial_configs (config_type='commission', scope='global' or 'organization')
  // TDS: financial_configs (config_type='tds')
  // No hardcoded rates in this method.

  private async _createSettlement(bookingId: number, orgId: number, grossAmount: number) {
    const existing = await turfSettlementRepository.findItemByBooking(bookingId);
    if (existing) return; // Idempotent

    const grossAmountPaise = Math.round(grossAmount * 100);
    const configSnapshot = await financialConfigService.getSnapshot(orgId);

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: configSnapshot,
    });

    // Convert paise → INR with 2dp, matching the DB column convention.
    const commissionAmount = parseFloat((breakdown.commission_paise / 100).toFixed(2));
    const tdsAmount = parseFloat((breakdown.tds_paise / 100).toFixed(2));
    const netAmount = parseFloat((breakdown.net_payable_to_business_paise / 100).toFixed(2));

    const pendingList = await turfSettlementRepository.findPendingByOrg(orgId);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await turfSettlementRepository.create({ organization_id: orgId });
    }
    await turfSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: bookingId,
      gross_amount: grossAmount,
      commission_amount: commissionAmount,
      tax_amount: 0,
      net_amount: netAmount,
    });
  }

  // ── Private: Wallet Coins ──────────────────────────────────────────────────

  private _awardCoins(userId: number, orgId: number, amount: number, bookingId: number) {
    const coins = Math.floor(amount);
    if (coins <= 0) return;

    turfWalletRepository.create({
      user_id: userId,
      organization_id: orgId,
      coins,
      balance_after: 0,
      type: 'earn',
      category: 'per_booking',
      booking_id: bookingId,
      description: `Earned ${coins} coins from booking`,
      actor_type: 'system',
    }).catch(err => logger.error(`[TurfWallet] Earn failed for booking ${bookingId}:`, err));
  }

  // ── Private: Refund Processing ─────────────────────────────────────────────

  private async _processRefund(bookingId: number, amount: number, reason: string | null) {
    const settlementItem = await turfSettlementRepository.findItemByBooking(bookingId);
    let netRefund = amount;
    if (settlementItem) {
      const commissionProportion = parseFloat(settlementItem.commission_amount) / parseFloat(settlementItem.gross_amount);
      const commissionDeduction = Math.round(amount * commissionProportion * 100) / 100;
      netRefund = Math.round((amount - commissionDeduction) * 100) / 100;
    }
    await turfRefundRepository.create({
      settlement_item_id: settlementItem?.id ?? null,
      booking_id: bookingId,
      amount: netRefund,
      reason: reason ?? 'Booking cancelled',
    });
    logger.info(`[TurfBooking] Refund processed: booking ${bookingId}, amount ${netRefund}`);
  }
}

export const turfBookingService = new TurfBookingService();
