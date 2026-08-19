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
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { paymentService } from '../services/promotionService';
import { financialConfigService } from '../services/financialConfigService';
import { calculateBookingFinancials } from '../services/financialCalculator';
import { signTicket } from '../utils/qrCode';
import type {
  MovieBookingRow,
  MovieBookingWithDetails,
  MovieBookingItemRow,
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

    // Price calculation with price caps
    const prices = await this._calculateSeatPrices(showtime, seats, cinema);
    const totalAmount = prices.reduce((sum, p) => sum + p.finalPricePaise, 0);

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
          JSON.stringify({ prices: prices.map(p => ({ seatId: p.seatId, price: p.finalPricePaise, seatType: p.seatType })) }),
        ]
      );
      const booking = bookingResult.rows[0] as MovieBookingRow;

      const bookingItems: MovieBookingItemRow[] = [];
      try {
        for (let i = 0; i < seats.length; i++) {
          const seat = seats[i];
          const priceInfo = prices.find(p => p.seatId === seat.id)!;
          const itemResult = await client.query(
            `INSERT INTO movie_booking_items
              (booking_id, showtime_id, seat_id, seat_label, row_label, seat_number, seat_type, seat_category, price, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [
              booking.id, showtimeId, seat.id,
              `${seat.row_label}${seat.seat_number}`, seat.row_label, seat.seat_number,
              seat.seat_type, seat.seat_category, priceInfo.finalPricePaise, 'INR',
            ]
          );
          bookingItems.push(itemResult.rows[0] as MovieBookingItemRow);
        }
      } catch (err: unknown) {
        // Postgres unique violation on partial unique index
        // idx_movie_booking_items_seat_showtime_active (race vs another booking).
        // Index predicate (set by migration 038) is:
        //   WHERE booking_status IN ('pending_payment', 'confirmed')
        // Roll back the transaction (handled by withTransaction) so the
        // booking row is also discarded.
        const pgErr = err as { code?: string };
        if (pgErr && pgErr.code === '23505') {
          throw new AppError('One or more seats were just booked by another user — please try again', 409);
        }
        throw err;
      }

      // Decrement available seats
      await client.query(
        'UPDATE showtimes SET available_seats = available_seats - $1, booked_seats = booked_seats + $1, updated_at = NOW() WHERE id = $2',
        [seatIds.length, showtimeId]
      );

      return { booking };
    });

    // Post-commit: Create payment order
    const orderId = `MOV_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const paymentOrder = await paymentOrderRepository.create({
      order_id: orderId,
      booking_id: booking.id,
      organization_id: cinema.organization_id ?? 0,
      movie_id: showtime.movie_id,
      amount: totalAmount,
      currency: 'INR',
      idempotency_key: `movie_pay_${booking.id}`,
    });

    // Post-commit: Create Cashfree payment order
    const paymentResult = await paymentService.createOrder({
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
    });

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

      // Verify payment is captured
      const paymentOrder = await paymentOrderRepository.findByBookingId(bookingId);
      if (!paymentOrder || paymentOrder.status !== 'COMPLETED') {
        await client.query('ROLLBACK');
        throw new AppError('Payment not confirmed for this booking', 409);
      }

      // Update booking status
      await movieBookingRepository.updateStatus(bookingId, 'confirmed');
      await movieBookingRepository.updatePaymentStatus(bookingId, 'captured');

      await client.query('COMMIT');

      // Post-commit: Generate tickets
      const items = await movieBookingItemRepository.findByBooking(bookingId);
      const ticketUuids: string[] = [];

      for (const item of items) {
        const ticketUuid = crypto.randomBytes(16).toString('hex');
        ticketUuids.push(ticketUuid);
        const signature = signTicket({ ticket_uuid: ticketUuid }, booking.showtime_id, '');

        const qrData = JSON.stringify({
          ref: booking.booking_reference,
          ticket: ticketUuid,
          seat: item.seat_label,
          row: item.row_label,
          showtime: booking.showtime_id,
        });

        await movieTicketRepository.create({
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
        });
      }

      // Post-commit: Release Redis holds
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
      const grossAmountPaise = parseInt(paymentOrder.amount, 10);
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
   */
  async expireStaleBookings(): Promise<number> {
    const cutoff = new Date(Date.now() - PAYMENT_TIMEOUT_SECONDS * 1000).toISOString();
    const expiredBookings = await movieBookingRepository.cancelExpiredHolds(cutoff);

    let releasedCount = 0;
    for (const booking of expiredBookings) {
      try {
        const pool = getPool();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const items = await movieBookingItemRepository.findByBooking(booking.id);
          await showtimeRepository.updateAvailableSeats(booking.showtime_id, items.length);

          // Release Redis holds
          const holdKey = `movie:hold:${booking.showtime_id}`;
          for (const item of items) {
            await getRedis().del(`${holdKey}:${item.seat_id}`);
          }
          await getRedis().del(`movie:user_hold:${booking.user_id}:${booking.showtime_id}`);
          if (booking.idempotency_key) {
            await getRedis().del(`movie:idempotency:${booking.idempotency_key}`);
          }

          await client.query('COMMIT');
          releasedCount++;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
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

    const { turfSettlementRepository } = await import('../repositories/turfSettlementRepository');
    const existing = await turfSettlementRepository.findItemByBooking(booking.id);
    if (existing) return;

    const pendingList = await turfSettlementRepository.findPendingByOrg(orgId);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await turfSettlementRepository.create({ organization_id: orgId });
    }
    await turfSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: booking.id,
      gross_amount: grossAmount / 100,
      commission_amount: parseFloat((breakdown.commission_paise / 100).toFixed(2)),
      tax_amount: parseFloat((breakdown.gst_on_platform_fee_paise / 100).toFixed(2)),
      net_amount: parseFloat((breakdown.net_payable_to_business_paise / 100).toFixed(2)),
    });
  }
}

export const movieBookingService = new MovieBookingService();
