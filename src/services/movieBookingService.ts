/**
 * MovieBookingService — core movie booking engine with Redis seat holds,
 * idempotency, price-cap enforcement, and payment orchestration.
 *
 * All amounts are in INTEGER paise.
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getPool, withTransaction } from '../db/pool';
import { getRedis } from '../db/redis';
import crypto from 'crypto';

import { movieRepository } from '../repositories/movieRepository';
import { cinemaRepository } from '../repositories/cinemaRepository';
import { cinemaSeatRepository } from '../repositories/cinemaSeatRepository';
import { showtimeRepository } from '../repositories/showtimeRepository';
import { movieBookingRepository } from '../repositories/movieBookingRepository';
import { movieBookingItemRepository } from '../repositories/movieBookingItemRepository';
import { movieTicketRepository } from '../repositories/movieTicketRepository';
import { moviePriceCapRepository } from '../repositories/moviePriceCapRepository';
import { movieSettlementRepository } from '../repositories/movieSettlementRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { getPaymentService, PaymentService } from './paymentService';
import { financialConfigService } from '../services/financialConfigService';
import { calculateBookingFinancials } from '../services/financialCalculator';
import { PricingEngine } from './pricingEngine';
import type { PricingBreakdown, FinancialSnapshot } from './pricingEngine';
import { signTicket } from '../utils/qrCode';
import { UniversalTicketService } from '../services/universalTicketService';
import type {
  MovieBookingRow,
  MovieBookingWithDetails,
  MovieBookingItemRow,
  MovieTicketRow,
  MovieRow,
  MovieSeatPrice,
  MovieBookingCreateInput,
  CinemaRow,
  ShowtimeRow,
  CinemaSeatRow,
  SeatHoldResult,
} from '../types';

// ── Constants ──────────────────────────────────────────────────────────────────

const HOLD_TTL_SECONDS = 600;          // 10-minute seat hold
const PAYMENT_TIMEOUT_SECONDS = 300;   // 5-minute payment window
const MAX_SEATS_PER_BOOKING = 10;
const SEAT_HOLD_LUA_KEY = 'movie:seat_hold';

// ── Redis Lua script for atomic seat hold ─────────────────────────────────────
// Redis eval argument layout:
//   KEYS[1]  = hold key prefix  (e.g. "movie:hold:42")
//   ARGV[1]  = TTL in seconds
//   ARGV[2..N+1] = individual seat id strings
//   ARGV[N+2]    = number of seats (count)
//
// For each seat, creates key "movie:hold:42:<seatId>" with SET NX (atomic
// check-and-set). Also SADD each seat to the set "movie:hold:42" so that
// releaseSeats() and createBooking() can recover seat IDs via SMEMBERS.
// Returns 1 on success, 0 + conflicted seat label on failure.

const SEAT_HOLD_LUA = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local count = tonumber(ARGV[#ARGV])

for i = 1, count do
  local seatKey = key .. ':' .. ARGV[i + 1]
  -- SET NX: set only if not exists (atomic check + set)
  local set = redis.call('SET', seatKey, 'held', 'EX', ttl, 'NX')
  if set == false then
    return { 0, ARGV[i + 1] }
  end
  -- Track seat in the set for recovery by releaseSeats / createBooking
  redis.call('SADD', key, ARGV[i + 1])
end

-- Set TTL on the tracking set so checkHold and stale-cleanup can detect expiry
redis.call('EXPIRE', key, ttl)

return { 1 }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateBookingReference(): string {
  return `MOV${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('base64url').slice(0, 6).toUpperCase()}`;
}

function generateIdempotencyKey(userId: number, showtimeId: number): string {
  return `movie_booking_${userId}_st_${showtimeId}`;
}

async function audit(bookingId: number, action: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO movie_booking_audits (booking_id, ticket_id, actor_type, actor_id, action, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        bookingId,
        extra.ticketId ?? null,
        extra.actorType ?? 'system',
        extra.actorId ?? null,
        action,
        { ...extra, timestamp: new Date().toISOString() },
      ]
    );
  } catch (err) {
    logger.error(`[MovieAudit] Failed for ${action}:`, err);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class MovieBookingService {

  /**
   * Hold seats in Redis (no DB write yet).
   * Returns the hold result with TTL. Frontend polls this or proceeds to payment.
   */
  async holdSeats(userId: number, showtimeId: number, seatIds: number[]): Promise<SeatHoldResult> {
    if (seatIds.length === 0) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }
    if (seatIds.length > MAX_SEATS_PER_BOOKING) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }

    // Verify showtime exists and is on sale
    const showtime = await showtimeRepository.findById(showtimeId);
    if (!showtime) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }
    if (showtime.status !== 'on_sale') {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }
    if (showtime.available_seats < seatIds.length) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }

    // Verify seats belong to the showtime's screen and are available
    const seats = await cinemaSeatRepository.findByIds(seatIds);
    if (seats.length !== seatIds.length) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: '', holdKey: '' };
    }

    const screenId = showtime.screen_id;
    const invalidSeat = seats.find(s => s.screen_id !== screenId || !s.is_available);
    if (invalidSeat) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [invalidSeat.id], holdExpiresAt: '', holdKey: '' };
    }

    // Idempotency: check if user already has a pending hold for this showtime
    const redis = getRedis();
    const userHoldKey = `movie:user_hold:${userId}:${showtimeId}`;
    const existingHold = await redis.get(userHoldKey);
    if (existingHold) {
      const holdData = JSON.parse(existingHold);
      return { success: false, heldSeatIds: [], conflictedSeatIds: [], holdExpiresAt: holdData.expiresAt, holdKey: userHoldKey };
    }

    // Atomic seat hold via Lua script
    const holdKey = `movie:hold:${showtimeId}`;
    const seatIdStrings = seatIds.map(String);
    const result = await redis.eval(
      SEAT_HOLD_LUA,
      1,
      holdKey,
      HOLD_TTL_SECONDS,
      ...seatIdStrings,
      seatIds.length
    ) as [number, string | undefined];

    if (result[0] === 0) {
      return { success: false, heldSeatIds: [], conflictedSeatIds: [Number(result[1])], holdExpiresAt: '', holdKey };
    }

    const expiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

    // Store user hold for idempotency check
    await redis.set(userHoldKey, JSON.stringify({ seatIds, expiresAt }), 'EX', HOLD_TTL_SECONDS);

    logger.info(`[MovieBooking] Seats held: user=${userId}, showtime=${showtimeId}, seats=${seatIds.join(',')}`);
    return { success: true, heldSeatIds: seatIds, conflictedSeatIds: [], holdExpiresAt: expiresAt, holdKey };
  }

  /**
   * Core booking creation from direct seat IDs (internal).
   * Used by the holdKey flow after extracting seats from Redis.
   */
  private async createBookingFromSeats(
    userId: number,
    input: MovieBookingCreateInput & { seatIds: number[]; customerEmail: string; customerPhone: string; customerName: string }
  ): Promise<{ booking: MovieBookingRow; paymentOrderId: string; paymentSessionId: string }> {
    const seatIds = input.seatIds;
    if (!seatIds || seatIds.length === 0) {
      throw new AppError('No seats selected', 400);
    }
    if (seatIds.length > MAX_SEATS_PER_BOOKING) {
      throw new AppError(`Maximum ${MAX_SEATS_PER_BOOKING} seats per booking`, 400);
    }

    const showtimeId = input.showtimeId;

    // Validate showtime
    const showtime = await showtimeRepository.findById(showtimeId);
    if (!showtime) throw new AppError('Showtime not found', 404);
    if (showtime.status !== 'on_sale') throw new AppError('Showtime is not available for booking', 400);

    // Get movie and cinema for organization lookup
    const movie = await movieRepository.findById(showtime.movie_id);
    if (!movie) throw new AppError('Movie not found', 404);

    const cinema = await cinemaRepository.findById(showtime.cinema_id);
    if (!cinema || cinema.status !== 'active') {
      throw new AppError('Cinema is not available', 400);
    }

    // Per-user-per-showtime booking limit
    const existingPending = await movieBookingRepository.findByShowtime(showtimeId);
    const userActiveBookings = existingPending.filter(
      b => b.user_id === userId && (b.status === 'pending_payment' || b.status === 'confirmed')
    );
    if (userActiveBookings.length > 0) {
      throw new AppError('You already have an active booking for this showtime', 409);
    }

    // Fetch seats and check availability
    const seats = await cinemaSeatRepository.findByIds(seatIds);
    if (seats.length !== seatIds.length) {
      throw new AppError('One or more seats are invalid', 400);
    }

    const invalidSeat = seats.find(s => s.screen_id !== showtime.screen_id || !s.is_available);
    if (invalidSeat) {
      throw new AppError('One or more seats are not available', 409);
    }

    // Check for double-booking
    const existingItems = await movieBookingItemRepository.findByShowtime(showtimeId);
    const bookedSeatIds = new Set(existingItems.map(i => i.seat_id));
    const doubleBooked = seats.find(s => bookedSeatIds.has(s.id));
    if (doubleBooked) {
      throw new AppError(`Seat ${doubleBooked.row_label}${doubleBooked.seat_number} is already booked`, 409);
    }

    // Price calculation with PricingEngine (GST + platform fee)
    const pricingEngine = new PricingEngine();
    const seatPrices = await this._calculateSeatPrices(showtime, seats, cinema);

    // Online movie: GST 18% + ₹20 platform fee per ticket
    let totalAmountPaise = 0;
    let totalAmountPaiseBreakdown: PricingBreakdown | null = null;
    const seatPricingResults: Array<{ seatId: number; totalPaise: number; basePaise: number }> = [];
    for (const seatPrice of seatPrices) {
      const breakdown = pricingEngine.calculate({
        domain: 'movie_online',
        unitPricePaise: seatPrice.finalPricePaise,
        quantity: 1,
        currency: 'INR',
      });
      totalAmountPaise += breakdown.totalPaise;
      totalAmountPaiseBreakdown = breakdown; // last seat breakdown has per-ticket values
      seatPricingResults.push({ seatId: seatPrice.seatId, totalPaise: breakdown.totalPaise, basePaise: seatPrice.finalPricePaise });
    }
    const totalAmount = totalAmountPaise;
    // Reconstruct aggregate breakdown for financial snapshot
    if (totalAmountPaiseBreakdown) {
      const perSeat = totalAmountPaiseBreakdown;
      totalAmountPaiseBreakdown = {
        domain: 'movie_online' as const,
        unitPricePaise: perSeat.unitPricePaise,
        quantity: seatIds.length,
        subtotalPaise: perSeat.subtotalPaise * seatIds.length,
        discountPaise: perSeat.discountPaise * seatIds.length,
        taxableAmountPaise: perSeat.taxableAmountPaise * seatIds.length,
        cgstPaise: perSeat.cgstPaise * seatIds.length,
        sgstPaise: perSeat.sgstPaise * seatIds.length,
        gstTotalPaise: perSeat.gstTotalPaise * seatIds.length,
        gstInclusivePaise: perSeat.gstInclusivePaise * seatIds.length,
        platformFeePaise: perSeat.platformFeePaise * seatIds.length,
        totalPaise: totalAmountPaise,
        currency: 'INR',
        pricingRuleVersion: perSeat.pricingRuleVersion,
        calculatedAt: perSeat.calculatedAt,
        perUnitBreakdown: perSeat.perUnitBreakdown,
      } as unknown as PricingBreakdown;
    }

    // Idempotency check
    const idempotencyKey = input.idempotencyKey || generateIdempotencyKey(userId, showtimeId);
    const cached = await getRedis().get(`movie:idempotency:${idempotencyKey}`);
    if (cached) {
      const data = JSON.parse(cached);
      const existing = await movieBookingRepository.findById(data.bookingId);
      if (existing && existing.status === 'pending_payment') {
        throw new AppError('Booking already in progress', 409);
      }
      if (existing) {
        const details = await movieBookingRepository.getBookingWithDetails(existing.id);
        return { booking: existing, paymentOrderId: '', paymentSessionId: '' };
      }
    }

    // Atomic booking creation
    const { booking } = await withTransaction(async (client) => {
      const stResult = await client.query(
        'SELECT * FROM showtimes WHERE id = $1 FOR UPDATE',
        [showtimeId]
      );
      const lockedShowtime = stResult.rows[0] as ShowtimeRow;
      if (!lockedShowtime) throw new AppError('Showtime not found', 404);
      if (lockedShowtime.status !== 'on_sale') throw new AppError('Showtime is not available', 400);
      if (lockedShowtime.available_seats < seatIds.length) {
        throw new AppError('Not enough seats available', 409);
      }

      const bookingRef = generateBookingReference();
      const orgId = cinema.organization_id;
      const holdExpiresAt = new Date(Date.now() + HOLD_TTL_SECONDS * 1000).toISOString();

      const bookingResult = await client.query(
        `INSERT INTO movie_bookings
          (booking_reference, user_id, organization_id, movie_id, cinema_id, cinema_screen_id,
           showtime_id, amount, currency, seat_count, status, payment_status,
           idempotency_key, hold_expires_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          bookingRef, userId, orgId, showtime.movie_id, showtime.cinema_id, showtime.screen_id,
          showtimeId, totalAmount, 'INR', seatIds.length,
          'pending_payment', 'initiated',
          idempotencyKey, holdExpiresAt,
          JSON.stringify({ prices: seatPrices.map(p => ({ seatId: p.seatId, price: p.finalPricePaise, seatType: p.seatType })) }),
        ]
      );
      const booking = bookingResult.rows[0] as MovieBookingRow;

      const bookingItems = await movieBookingItemRepository.bulkCreate(
        seats.map(seat => {
          const priceInfo = seatPrices.find(p => p.seatId === seat.id)!;
          return {
            booking_id: booking.id, showtime_id: showtimeId, seat_id: seat.id,
            seat_label: `${seat.row_label}${seat.seat_number}`, row_label: seat.row_label, seat_number: seat.seat_number,
            seat_type: seat.seat_type, seat_category: seat.seat_category,
            price: priceInfo.finalPricePaise, currency: 'INR',
          };
        }),
        client
      );

      // Decrement available seats (with sold_out transition)
      await showtimeRepository.updateAvailableSeats(showtimeId, -seatIds.length, client);

      return { booking };
    });

    // Post-commit: Create payment order (this MUST succeed — if it fails, cancel the booking
    // and release seats so the user can retry. A dangling pending_payment booking with no
    // payment order is worse than a failed attempt.)
    const orderId = `MOV_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    let paymentResult: { order: { order_id: string }; paymentSessionId: string } | null = null;
    try {
      const paymentService = getPaymentService();
      const financialSnapshot: FinancialSnapshot | null = totalAmountPaiseBreakdown
        ? PricingEngine.toSnapshot(totalAmountPaiseBreakdown, 'online')
        : null;
      paymentResult = await paymentService.createOrder({
        booking_id: booking.id,
        order_id: orderId,
        amount: totalAmount,
        currency: 'INR',
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        orderId: orderId,
        organization_id: cinema.organization_id ?? 0,
        movie_id: showtime.movie_id,
        idempotency_key: `movie_pay_${booking.id}`,
        financial_snapshot: financialSnapshot as { [key: string]: unknown } | null,
      });
    } catch (err) {
      // Payment order creation failed — cancel the booking to release seats
      logger.error('[MovieBooking] Payment order creation failed — cancelling booking', {
        bookingId: booking.id,
        bookingReference: booking.booking_reference,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await this.cancelBooking(booking.id, userId, 'Payment system unavailable — please retry', {
          actorId: userId,
          actorType: 'system',
        });
      } catch (cancelErr) {
        logger.error('[MovieBooking] Failed to cancel booking after payment order failure', {
          bookingId: booking.id,
          error: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        });
      }
      throw new AppError('Payment system temporarily unavailable. Please try again in a moment.', 503);
    }

    if (!paymentResult) {
      // Defensive: should never reach here since throw above handles null
      throw new AppError('Payment order creation failed', 500);
    }

    // Cache idempotency
    await getRedis().set(`movie:idempotency:${idempotencyKey}`, JSON.stringify({ bookingId: booking.id }), 'EX', PAYMENT_TIMEOUT_SECONDS + 60);

    // Extend seat hold TTL to match payment window
    const holdKey = `movie:hold:${showtimeId}`;
    for (const seatId of seatIds) {
      await getRedis().expire(`${holdKey}:${seatId}`, PAYMENT_TIMEOUT_SECONDS);
    }
    await getRedis().expire(`movie:user_hold:${userId}:${showtimeId}`, PAYMENT_TIMEOUT_SECONDS);

    await audit(booking.id, 'booking.created', {
      actorType: 'user', actorId: userId,
      details: { showtimeId, seatIds, totalAmount, paymentOrderId: orderId },
    });

    logger.info(`[MovieBooking] Created: ${booking.booking_reference}, amount=${totalAmount}, seats=${seatIds.length}`);
    return {
      booking,
      paymentOrderId: paymentResult.order.order_id,
      paymentSessionId: paymentResult.paymentSessionId,
    };
  }

  /**
   * Confirm booking after successful payment (core, takes bookingId).
   * Called by webhook handler or internal orchestration.
   */
  async confirmBooking(bookingId: number): Promise<MovieBookingWithDetails> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the booking
      const bookingResult = await client.query(
        'SELECT * FROM movie_bookings WHERE id = $1 FOR UPDATE',
        [bookingId]
      );
      const booking = bookingResult.rows[0] as MovieBookingRow | undefined;
      if (!booking) {
        await client.query('ROLLBACK');
        throw new AppError('Booking not found', 404);
      }
      if (booking.status === 'confirmed') {
        await client.query('COMMIT');
        const details = await movieBookingRepository.getBookingWithDetails(bookingId);
        if (!details) throw new AppError('Booking not found', 404);
        return details;
      }
      if (booking.status !== 'pending_payment') {
        await client.query('COMMIT');
        throw new AppError(`Booking is in status: ${booking.status}`, 400);
      }

      // Verify payment is captured. If not yet captured, poll the gateway once
      // so the customer returning from payment can get an immediate confirmation
      // instead of waiting for the webhook.
      let paymentOrder = await paymentOrderRepository.findByBookingId(bookingId);
      if (!paymentOrder) {
        await client.query('ROLLBACK');
        throw new AppError('Payment order not found for this booking', 409);
      }

      if (paymentOrder.status !== 'COMPLETED') {
        if (paymentOrder.status === 'ACTIVE' || paymentOrder.status === 'CREATED') {
          try {
            const paymentService = getPaymentService();
            paymentOrder = await paymentService.verifyPayment(paymentOrder.order_id);
          } catch (verifyErr) {
            logger.warn('[MovieBooking] Payment verification poll failed', {
              bookingId, orderId: paymentOrder.order_id, error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
            });
          }
        }

        if (!paymentOrder || paymentOrder.status !== 'COMPLETED') {
          await client.query('ROLLBACK');
          throw new AppError('Payment not confirmed for this booking', 409);
        }
      }

      // Verify payment amount matches server-calculated amount
      // booking.amount = totalAmountPaise (paise), paymentOrder.amount = totalAmountPaise (paise string)
      const expectedAmountPaise = Math.round(Number(booking.amount));
      const paidAmountPaise = Math.round(Number(paymentOrder.amount));
      const paymentService = getPaymentService();
      paymentService.verifyPaymentAmount(expectedAmountPaise, paidAmountPaise);

      // Update booking status
      await movieBookingRepository.updateStatus(bookingId, 'confirmed');
      await movieBookingRepository.updatePaymentStatus(bookingId, 'captured');

      // Generate tickets atomically inside the transaction
      // If ticket creation fails, the entire confirmation rolls back
      const items = await movieBookingItemRepository.findByBooking(bookingId);
      // Fetch the showtime start time to bind the ticket signature to this specific showtime
      const showtimeRow = await client.query('SELECT show_datetime FROM showtimes WHERE id = $1 LIMIT 1', [booking.showtime_id]);
      const showtimeStart = new Date(showtimeRow.rows[0]?.show_datetime || Date.now()).toISOString();

      const ticketData = items.map(item => {
        const ticketUuid = UniversalTicketService.generateTicketUuid('movie');
        const signature = UniversalTicketService.sign({ domain: 'movie', ticketUuid, entityId: booking.showtime_id, startAt: showtimeStart });
        const qrData = JSON.stringify({
          ref: booking.booking_reference,
          ticket: ticketUuid,
          seat: item.seat_label,
          row: item.row_label,
          showtime: booking.showtime_id,
          domain: 'movie',
        });
        return {
          booking_id: booking.id,
          booking_item_id: item.id,
          ticket_uuid: ticketUuid,
          showtime_id: booking.showtime_id,
          seat_label: item.seat_label,
          row_label: item.row_label,
          seat_number: item.seat_number,
          seat_type: item.seat_type,
          qr_data: qrData,
          signature,
        };
      });
      await movieTicketRepository.bulkCreate(ticketData, client);

      await client.query('COMMIT');

      // Post-commit: Release Redis holds (safe to do after commit — holds already locked)
      const showtime = await showtimeRepository.findById(booking.showtime_id);
      if (showtime) {
        const holdKey = `movie:hold:${showtime.id}`;
        for (const item of items) {
          await getRedis().del(`${holdKey}:${item.seat_id}`);
        }
        await getRedis().del(`movie:user_hold:${booking.user_id}:${showtime.id}`);
        if (booking.idempotency_key) {
          await getRedis().del(`movie:idempotency:${booking.idempotency_key}`);
        }
      }

      // Post-commit: Settlement
      // Use base subtotal from financial snapshot (pre-GST, pre-platform-fee)
      const snapshot = (paymentOrder as any).financial_snapshot as Record<string, unknown> | null;
      const grossAmountPaise = typeof snapshot?.subtotalPaise === 'number' && snapshot.subtotalPaise > 0
        ? snapshot.subtotalPaise
        : Math.round(Number(paymentOrder.amount));
      await this._createSettlement(booking, grossAmountPaise);

      await audit(booking.id, 'booking.confirmed', {
        actorType: 'system',
        details: { paymentOrderId: paymentOrder.order_id, ticketCount: items.length },
      });

      const details = await movieBookingRepository.getBookingWithDetails(bookingId);
      logger.info(`[MovieBooking] Confirmed: ${booking.booking_reference}`);
      if (!details) throw new AppError('Booking not found after confirmation', 404);
      return details;

    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`[MovieBooking] Confirm failed for ${bookingId}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cancel a movie booking (core, takes bookingId + actor info).
   */
  async cancelBooking(
    bookingId: number,
    userId: number,
    reason: string | null,
    actor: { actorId: number; actorType: string }
  ): Promise<{ cancelled: boolean; refundEligible: boolean }> {
    const booking = await movieBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    if (booking.status === 'cancelled') {
      return { cancelled: true, refundEligible: false };
    }
    if (booking.status === 'confirmed') {
      throw new AppError('Cannot cancel a confirmed booking — please contact support for refund', 400);
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      await movieBookingRepository.updateStatus(bookingId, 'cancelled');

      // Release seats: increment available_seats back
      const items = await movieBookingItemRepository.findByBooking(bookingId);
      await showtimeRepository.updateAvailableSeats(
        booking.showtime_id,
        items.length
      );

      // Release Redis holds
      const holdKey = `movie:hold:${booking.showtime_id}`;
      for (const item of items) {
        await getRedis().del(`${holdKey}:${item.seat_id}`);
      }
      await getRedis().del(`movie:user_hold:${userId}:${booking.showtime_id}`);
      if (booking.idempotency_key) {
        await getRedis().del(`movie:idempotency:${booking.idempotency_key}`);
      }

      // Delete booking items
      await movieBookingItemRepository.deleteByBooking(bookingId);

      // Revoke any generated tickets
      const tickets = await movieTicketRepository.findByBooking(bookingId);
      for (const ticket of tickets) {
        await movieTicketRepository.revoke(ticket.id, actor.actorId, 'Booking cancelled');
      }

      await client.query('COMMIT');

      await audit(booking.id, 'booking.cancelled', {
        actorId: actor.actorId, actorType: actor.actorType,
        details: { reason, seatCount: items.length },
      });

      logger.info(`[MovieBooking] Cancelled: ${booking.booking_reference}`);
      return { cancelled: true, refundEligible: false };

    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`[MovieBooking] Cancel failed for ${bookingId}:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Worker: expire stale pending_payment bookings and release seats.
   * Uses withTransaction for each booking — connection is properly acquired
   * and released per booking instead of being left open between iterations.
   */
  async expireStaleBookings(): Promise<number> {
    const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_SECONDS * 1000).toISOString();
    const expiredBookings = await movieBookingRepository.cancelExpiredHolds(cutoff);

    let releasedCount = 0;
    for (const booking of expiredBookings) {
      try {
        await withTransaction(async (client) => {
          const items = await movieBookingItemRepository.findByBooking(booking.id);
          await showtimeRepository.updateAvailableSeats(booking.showtime_id, items.length, client);

          // Release Redis holds
          const holdKey = `movie:hold:${booking.showtime_id}`;
          for (const item of items) {
            await getRedis().del(`${holdKey}:${item.seat_id}`);
          }
          await getRedis().del(`movie:user_hold:${booking.user_id}:${booking.showtime_id}`);
          if (booking.idempotency_key) {
            await getRedis().del(`movie:idempotency:${booking.idempotency_key}`);
          }
        });
        releasedCount++;
      } catch (err) {
        logger.error(`[MovieWorker] Failed to expire booking ${booking.id}:`, err);
      }
    }

    if (releasedCount > 0) {
      logger.info(`[MovieWorker] Expired ${releasedCount} stale movie bookings`);
    }
    return releasedCount;
  }

  // ── Controller-facing APIs (higher-level, user/booking reference aware) ────────

  /**
   * Create booking from a holdKey. Controller-facing API.
   */
  async createBooking(input: {
    userId: number;
    holdKey: string;
    idempotencyKey?: string;
    customerEmail?: string;
    customerPhone?: string;
    customerName?: string;
    notes?: string;
  }): Promise<{ booking: MovieBookingRow; paymentOrderId: string; paymentSessionId: string }> {
    const redis = getRedis();
    const seatIdStrings = await redis.smembers(input.holdKey);
    if (seatIdStrings.length === 0) {
      throw new AppError('Hold expired or not found', 409);
    }
    const seatIds = seatIdStrings.map(Number).filter(Number.isFinite);

    const match = input.holdKey.match(/^movie:hold:(\d+)$/);
    if (!match) {
      throw new AppError('Invalid hold key format', 400);
    }
    const showtimeId = parseInt(match[1], 10);

    // Resolve showtime and related data for the booking input
    const showtime = await showtimeRepository.findById(showtimeId);
    if (!showtime) throw new AppError('Showtime not found', 404);
    const movie = await movieRepository.findById(showtime.movie_id);
    const cinema = await cinemaRepository.findById(showtime.cinema_id);

    const idempKey = input.idempotencyKey || generateIdempotencyKey(input.userId, showtimeId);

    return this.createBookingFromSeats(input.userId, {
      userId: input.userId,
      organizationId: cinema?.organization_id ?? null,
      movieId: showtime.movie_id,
      cinemaId: showtime.cinema_id,
      cinemaScreenId: showtime.screen_id,
      showtimeId,
      amount: 0, // will be calculated inside createBookingFromSeats
      currency: 'INR',
      seatCount: seatIds.length,
      seatIds,
      idempotencyKey: idempKey,
      customerEmail: input.customerEmail || '',
      customerPhone: input.customerPhone || '',
      customerName: input.customerName || '',
    });
  }

  /**
   * Confirm booking by reference. Controller-facing API.
   */
  async confirmBookingByReference(input: {
    userId: number;
    bookingReference: string;
    paymentOrderId?: string;
  }): Promise<MovieBookingWithDetails> {
    const booking = await movieBookingRepository.findByReference(input.bookingReference);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== input.userId) throw new AppError('Not your booking', 403);
    return this.confirmBooking(booking.id);
  }

  /**
   * Cancel booking by reference. Controller-facing API.
   */
  async cancelBookingByReference(
    userId: number,
    reference: string,
    reason: string | null
  ): Promise<{ cancelled: boolean; refundEligible: boolean }> {
    const booking = await movieBookingRepository.findByReference(reference);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    return this.cancelBooking(booking.id, userId, reason, { actorId: userId, actorType: 'user' });
  }

  /**
   * Get a booking by reference for a specific user.
   */
  async getBookingForUser(userId: number, reference: string): Promise<MovieBookingWithDetails | null> {
    const booking = await movieBookingRepository.findByReference(reference);
    if (!booking || booking.user_id !== userId) return null;
    return movieBookingRepository.getBookingWithDetails(booking.id);
  }

  /**
   * List bookings for a user.
   */
  async listMyBookings(
    userId: number,
    query: { status?: string; upcoming?: boolean; page?: number; pageSize?: number }
  ): Promise<{ items: MovieBookingRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
    if (query.upcoming) {
      const result = await movieBookingRepository.findByUser(userId, { page: query.page || 1, pageSize: query.pageSize || 25 });
      const now = new Date().toISOString();
      let filtered = result.items.filter((b: MovieBookingRow) => {
        // Exclude expired/cancelled and check showtime is in the future
        if (b.status === 'cancelled' || b.status === 'expired') return false;
        return true;
      });
      if (query.status) {
        filtered = filtered.filter((b: MovieBookingRow) => b.status === query.status);
      }
      return {
        items: filtered,
        total: filtered.length,
        page: 1,
        pageSize: filtered.length,
        totalPages: 1,
      };
    }
    const result = await movieBookingRepository.findByUser(userId, { page: query.page || 1, pageSize: query.pageSize || 25 });
    if (query.status) {
      const filtered = result.items.filter((b: MovieBookingRow) => b.status === query.status);
      return {
        items: filtered,
        total: filtered.length,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: 1,
      };
    }
    return result;
  }

  /**
   * Return a complete, structured seat layout for the frontend.
   *
   * For every seat in the screen this endpoint provides:
   *   seatId, rowLabel, seatNumber, seatType, seatCategory,
   *   xPosition, yPosition, pricePaise (with cap applied), status.
   *
   * Status is derived from Redis holds + DB booking_items:
   *   'booked'  — confirmed or pending_payment booking in DB
   *   'held'    — Redis hold key exists (other user's hold)
   *   'available' — free
   *
   * This is the single source of truth for seat availability.
   */
  async getSeatLayout(showtimeId: number): Promise<{
    showtimeId: number;
    screenId: number;
    price: number;
    currency: string;
    rows: Array<{
      rowLabel: string;
      seats: Array<{
        seatId: number;
        seatNumber: number;
        seatType: string;
        seatCategory: string;
        xPosition: number | null;
        yPosition: number | null;
        status: 'available' | 'held' | 'booked';
        pricePaise: number;
      }>;
    }>;
  }> {
    const showtime = await showtimeRepository.findById(showtimeId);
    if (!showtime) {
      throw new AppError('Showtime not found', 404);
    }

    const cinema = await cinemaRepository.findById(showtime.cinema_id);
    if (!cinema) {
      throw new AppError('Cinema not found', 404);
    }

    // Get all seats for this screen
    const allSeats = await cinemaSeatRepository.findByScreen(showtime.screen_id);

    // Get DB-level booked seats for this showtime
    const bookedItems = await movieBookingItemRepository.findByShowtime(showtimeId);
    const bookedSeatIds = new Set(bookedItems.map(i => i.seat_id));

    // Get Redis-held seat IDs for this showtime
    const redis = getRedis();
    const holdKey = `movie:hold:${showtimeId}`;
    const heldSeatIdStrings: string[] = await redis.smembers(holdKey);
    const heldSeatIds = new Set(heldSeatIdStrings.map(s => Number(s)).filter(Number.isFinite));

    // Price cap lookup
    const priceCap = await moviePriceCapRepository.findApplicable(
      cinema.organization_id, cinema.city, cinema.state, 'all'
    );

    const premiumMultipliers: Record<string, number> = {
      premium: 1.3,
      sofa: 1.6,
      couple: 1.5,
      wheelchair: 1.0,
    };

    // Build rows from cinema_seats directly, attaching status + price per seat
    const seatMap = new Map<string, typeof allSeats>();
    for (const seat of allSeats) {
      const rl = seat.row_label;
      if (!seatMap.has(rl)) seatMap.set(rl, []);
      seatMap.get(rl)!.push(seat);
    }

    const rows = Array.from(seatMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([rowLabel, rowSeats]) => ({
        rowLabel,
        seats: rowSeats.map(seat => {
          let price = showtime.price;
          const multiplier = premiumMultipliers[seat.seat_type] || 1.0;
          price = Math.round(price * multiplier);

          if (priceCap?.max_price_paise && price > priceCap.max_price_paise) {
            price = priceCap.max_price_paise;
          }

          let status: 'available' | 'held' | 'booked' = 'available';
          if (bookedSeatIds.has(seat.id)) {
            status = 'booked';
          } else if (heldSeatIds.has(seat.id)) {
            status = 'held';
          }

          return {
            seatId: seat.id,
            seatNumber: seat.seat_number,
            seatType: seat.seat_type,
            seatCategory: seat.seat_category,
            xPosition: seat.x_position != null ? Number(seat.x_position) : null,
            yPosition: seat.y_position != null ? Number(seat.y_position) : null,
            status,
            pricePaise: price,
          };
        }).sort((a, b) => a.seatNumber - b.seatNumber),
      }));

    return {
      showtimeId,
      screenId: showtime.screen_id,
      price: showtime.price,
      currency: showtime.currency,
      rows,
    };
  }

  /**
   * Calculate prices for selected seats without booking.
   */
  async calculatePrices(showtimeId: number, seatIds: number[]): Promise<MovieSeatPrice[]> {
    if (seatIds.length === 0) return [];

    const showtime = await showtimeRepository.findById(showtimeId);
    if (!showtime) throw new AppError('Showtime not found', 404);

    const cinema = await cinemaRepository.findById(showtime.cinema_id);
    if (!cinema) throw new AppError('Cinema not found', 404);

    const seats = await cinemaSeatRepository.findByIds(seatIds);
    if (seats.length !== seatIds.length) {
      throw new AppError('One or more seats are invalid', 400);
    }

    const invalidSeat = seats.find(s => s.screen_id !== showtime.screen_id || !s.is_available);
    if (invalidSeat) {
      throw new AppError('One or more seats are not available', 400);
    }

    return this._calculateSeatPrices(showtime, seats, cinema);
  }

  /**
   * Release a user's seat hold (without booking).
   */
  async releaseSeats(userId: number, holdKey: string): Promise<void> {
    const redis = getRedis();
    const seatIdStrings = await redis.smembers(holdKey);
    for (const sid of seatIdStrings) {
      await redis.del(`${holdKey}:${sid}`);
    }
    await redis.del(holdKey);

    // Clean up user hold
    const match = holdKey.match(/movie:hold:(\d+)$/);
    if (match) {
      const showtimeId = match[1];
      await redis.del(`movie:user_hold:${userId}:${showtimeId}`);
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────────

  /**
   * Get booking with full details (for ticket display).
   */
  async getBookingWithDetails(bookingId: number): Promise<MovieBookingWithDetails | null> {
    return movieBookingRepository.getBookingWithDetails(bookingId);
  }

  /**
   * Get user's booking history.
   */
  async getMyBookings(userId: number, page = 1, pageSize = 25): Promise<{ items: MovieBookingRow[]; total: number }> {
    return movieBookingRepository.findByUser(userId, { page, pageSize });
  }

  /**
   * Validate seats and compute prices for a showtime.
   * Enforces configurable price caps (e.g., Tamil Nadu govt regulations).
   */
  private async _calculateSeatPrices(
    showtime: ShowtimeRow,
    seats: CinemaSeatRow[],
    cinema: CinemaRow
  ): Promise<MovieSeatPrice[]> {
    const basePrice = showtime.price;

    // Look up applicable price cap
    const priceCap = await moviePriceCapRepository.findApplicable(
      cinema.organization_id,
      cinema.city,
      cinema.state,
      'all'
    );

    return seats.map(seat => {
      let price = basePrice;

      // Premium seats get a multiplier (configurable per screen)
      const premiumMultipliers: Record<string, number> = {
        'premium': 1.3,
        'sofa': 1.6,
        'couple': 1.5,
        'wheelchair': 1.0,
      };
      const multiplier = premiumMultipliers[seat.seat_type] || 1.0;
      price = Math.round(basePrice * multiplier);

      // Enforce price cap if configured
      let capped = false;
      let capReason: string | null = null;
      if (priceCap?.max_price_paise && price > priceCap.max_price_paise) {
        price = priceCap.max_price_paise;
        capped = true;
        capReason = `Price capped at ${priceCap.max_price_paise} paise by ${cinema.city}, ${cinema.state} regulation`;
      }

      return {
        seatId: seat.id,
        basePricePaise: basePrice,
        finalPricePaise: price,
        seatType: seat.seat_type,
        capped,
        capReason,
      };
    });
  }

  async searchMovies(query: string, page = 1, pageSize = 20): Promise<{
    items: any[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const q = query.trim();
    if (q.length < 2) {
      return { items: [], total: 0, page, pageSize, totalPages: 0 };
    }
    const result = await movieRepository.search({
      q,
      status: 'now_showing',
      page,
      pageSize: Math.min(pageSize, 100),
    });
    return {
      items: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  /**
   * Post-confirm: create settlement record using financial calculator.
   */
  private async _createSettlement(booking: MovieBookingRow, grossAmount: number): Promise<void> {
    const grossAmountPaise = Math.round(grossAmount);
    const orgId = booking.organization_id || 0;
    const configSnapshot = await financialConfigService.getSnapshot(orgId);

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: configSnapshot,
    });

    const pendingList = await movieSettlementRepository.findPendingByOrg(orgId);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await movieSettlementRepository.findOrCreatePendingSettlement(orgId);
    }
    await movieSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: booking.id,
      gross_amount: grossAmountPaise / 100,
      commission_amount: parseFloat((breakdown.commission_paise / 100).toFixed(2)),
      tax_amount: parseFloat((breakdown.gst_on_platform_fee_paise / 100).toFixed(2)),
      net_amount: parseFloat((breakdown.net_payable_to_business_paise / 100).toFixed(2)),
    });
  }
}

export const movieBookingService = new MovieBookingService();
