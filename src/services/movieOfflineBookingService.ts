/**
 * MovieOfflineBookingService — counter / walk-in booking for movie domain.
 *
 * Flow:
 *   1. Staff selects showtime + seats for a customer
 *   2. System validates seats, computes price with caps
 *   3. Staff selects payment method: CASH / UPI / CARD
 *   4. Booking is created with payment_status = 'paid_offline'
 *   5. Tickets are generated immediately (no payment gateway)
 *   6. Redis holds are NOT used (staff bypasses hold mechanism)
 *
 * All amounts in INTEGER paise.
 * Payment gateway recorded as 'manual' in payment_orders.
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getPool, withTransaction } from '../db/pool';
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
import { financialConfigService } from '../services/financialConfigService';
import { calculateBookingFinancials } from '../services/financialCalculator';
import { PricingEngine } from '../services/pricingEngine';
import { movieSettlementRepository } from '../repositories/movieSettlementRepository';
import { UniversalTicketService } from '../services/universalTicketService';
import type {
  MovieBookingRow,
  MovieBookingWithDetails,
  MovieBookingItemRow,
  MovieSeatPrice,
  MovieBookingType,
  MoviePaymentStatus,
  OfflinePaymentMethod,
  MovieSeatType,
} from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SEATS_PER_OFFLINE_BOOKING = 10;
const OFFLINE_REFERENCE_PREFIX = 'OFMOV';

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateOfflineReference(): string {
  return `${OFFLINE_REFERENCE_PREFIX}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('base64url').slice(0, 6).toUpperCase()}`;
}

function generateIdempotencyKey(showtimeId: number, seatIds: number[]): string {
  const seatPart = seatIds.sort((a, b) => a - b).join(',');
  return `movie_offline_st${showtimeId}_${seatPart}`;
}

async function audit(bookingId: number, action: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO movie_booking_audits (booking_id, ticket_id, actor_type, actor_id, action, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        bookingId,
        extra.ticketId ?? null,
        extra.actorType ?? 'staff',
        extra.actorId ?? null,
        action,
        { ...extra, timestamp: new Date().toISOString() },
      ]
    );
  } catch (err) {
    logger.error(`[MovieOffline] Audit failed for ${action}:`, err);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export class MovieOfflineBookingService {

  /**
   * Create an offline (counter) booking with direct payment.
   *
   * @param staffUserId   — organizer_user.id of the staff member (owner or manager)
   * @param organizationId — org the cinema belongs to
   * @param input         — booking details + payment info
   */
  async createOfflineBooking(
    staffUserId: number,
    organizationId: number,
    input: {
      showtimeId: number;
      seatIds: number[];
      customerName: string;
      customerEmail?: string;
      customerPhone?: string;
      paymentMethod: OfflinePaymentMethod;
      paymentReference?: string;   // UPI txn ID, card last4, etc.
      notes?: string;
      seatIdsSignature: string;    // sorted comma-separated seat IDs for idempotency
    }
  ): Promise<{
    booking: MovieBookingRow;
    paymentOrderId: string;
    tickets: Array<{ ticketUuid: string; seatLabel: string; rowLabel: string; seatNumber: number; seatType: string; signature: string; qrData: string }>;
  }> {
    const seatIds = input.seatIds;
    if (seatIds.length === 0) {
      throw new AppError('No seats selected', 400);
    }
    if (seatIds.length > MAX_SEATS_PER_OFFLINE_BOOKING) {
      throw new AppError(`Maximum ${MAX_SEATS_PER_OFFLINE_BOOKING} seats per offline booking`, 400);
    }
    if (!input.customerName?.trim()) {
      throw new AppError('Customer name is required', 400);
    }
    if (!['CASH', 'UPI', 'CARD'].includes(input.paymentMethod)) {
      throw new AppError('Payment method must be CASH, UPI, or CARD', 400);
    }
    if (input.paymentMethod === 'UPI' && !input.paymentReference?.trim()) {
      throw new AppError('UPI transaction reference is required', 400);
    }

    // ── Validate showtime ─────────────────────────────────────────────────────

    const showtime = await showtimeRepository.findById(input.showtimeId);
    if (!showtime) {
      throw new AppError('Showtime not found', 404);
    }
    if (showtime.status !== 'on_sale') {
      throw new AppError('Showtime is not available for booking', 400);
    }
    if (showtime.available_seats < seatIds.length) {
      throw new AppError('Not enough seats available', 409);
    }
    if (showtime.organization_id !== organizationId) {
      throw new AppError('Showtime does not belong to your organization', 403);
    }

    // ── Validate seats ────────────────────────────────────────────────────────

    const seats = await cinemaSeatRepository.findByIds(seatIds);
    if (seats.length !== seatIds.length) {
      throw new AppError('One or more seats are invalid', 400);
    }

    const invalidSeat = seats.find(s => s.screen_id !== showtime.screen_id || !s.is_available);
    if (invalidSeat) {
      throw new AppError(`Seat ${invalidSeat.row_label}${invalidSeat.seat_number} is not available`, 409);
    }

    // ── Check for double-booking ──────────────────────────────────────────────

    const existingItems = await movieBookingItemRepository.findByShowtime(input.showtimeId);
    const bookedSeatIds = new Set(existingItems.map(i => i.seat_id));
    const doubleBooked = seats.find(s => bookedSeatIds.has(s.id));
    if (doubleBooked) {
      throw new AppError(`Seat ${doubleBooked.row_label}${doubleBooked.seat_number} is already booked`, 409);
    }

    // ── Idempotency check ─────────────────────────────────────────────────────

    const idempotencyKey = `movie_offline_${input.seatIdsSignature}`;
    const cached = await getPool().query(
      'SELECT id FROM movie_bookings WHERE idempotency_key = $1 AND deleted_at IS NULL LIMIT 1',
      [idempotencyKey]
    );
    if (cached.rows.length > 0) {
      const existingBooking = await movieBookingRepository.findById(cached.rows[0].id);
      if (existingBooking) {
        logger.info(`[MovieOffline] Idempotent request, returning existing booking ${existingBooking.booking_reference}`);
        // Return existing booking with its tickets
        const items = await movieBookingItemRepository.findByBooking(existingBooking.id);
        const existingTickets = await movieTicketRepository.findByBooking(existingBooking.id);
        return {
          booking: existingBooking,
          paymentOrderId: existingBooking.booking_reference,
          tickets: existingTickets.map(t => ({
            ticketUuid: t.ticket_uuid,
            seatLabel: t.seat_label,
            rowLabel: t.row_label,
            seatNumber: t.seat_number,
            seatType: t.seat_type,
            signature: t.signature,
            qrData: t.qr_data,
          })),
        };
      }
    }

    // ── Price calculation with caps ───────────────────────────────────────────

    const movie = await movieRepository.findById(showtime.movie_id);
    if (!movie) throw new AppError('Movie not found', 404);

    const cinema = await cinemaRepository.findById(showtime.cinema_id);
    if (!cinema || cinema.status !== 'active') {
      throw new AppError('Cinema is not available', 400);
    }

    const prices = await this._calculateSeatPrices(showtime, seats, cinema);

    // Offline (manager/counter) booking: GST 18% + 2% platform fee on base
    const pricingEngine = new PricingEngine();
    let totalAmountPaise = 0;
    let aggregatePlatformFeePaise = 0;
    let aggregateGstTotalPaise = 0;
    const seatPricingResults: Array<{ seatId: number; totalPaise: number; basePaise: number }> = [];
    for (const seatPrice of prices) {
      const breakdown = pricingEngine.calculate({
        domain: 'movie_manager',
        unitPricePaise: seatPrice.finalPricePaise,
        quantity: 1,
        currency: 'INR',
      });
      totalAmountPaise += breakdown.totalPaise;
      aggregatePlatformFeePaise += breakdown.platformFeePaise;
      aggregateGstTotalPaise += breakdown.gstTotalPaise;
      seatPricingResults.push({ seatId: seatPrice.seatId, totalPaise: breakdown.totalPaise, basePaise: seatPrice.finalPricePaise });
    }
    const totalAmount = totalAmountPaise;

    const baseSubtotalPaise = seatPricingResults.reduce((sum, p) => sum + p.basePaise, 0);

    // Build a proper pricing snapshot for the payment order (audit trail)
    // Use values aggregated from per-seat PricingEngine breakdowns
    const pricingSnapshot: Record<string, unknown> = {
      domain: 'movie_manager',
      bookingChannel: 'offline',
      subtotalPaise: baseSubtotalPaise,
      platformFeePaise: aggregatePlatformFeePaise,
      gstTotalPaise: aggregateGstTotalPaise,
      totalPaise: totalAmountPaise,
      currency: 'INR',
      seatCount: seatIds.length,
      seatPrices: seatPricingResults,
      calculatedAt: new Date().toISOString(),
    };

    // ── Atomic booking creation (no payment gateway) ──────────────────────────

    const { booking, items: bookingItems } = await withTransaction(async (client) => {
      // Lock the showtime
      const stResult = await client.query(
        'SELECT * FROM showtimes WHERE id = $1 FOR UPDATE',
        [input.showtimeId]
      );
      const lockedShowtime = stResult.rows[0];
      if (!lockedShowtime) throw new AppError('Showtime not found', 404);
      if (lockedShowtime.status !== 'on_sale') throw new AppError('Showtime is not available', 400);
      if (lockedShowtime.available_seats < seatIds.length) {
        throw new AppError('Not enough seats available', 409);
      }

      const bookingRef = generateOfflineReference();

      // Insert booking
      const bookingResult = await client.query(
        `INSERT INTO movie_bookings
          (booking_reference, user_id, organization_id, movie_id, cinema_id, cinema_screen_id,
           showtime_id, amount, currency, seat_count, booking_type, offline_by_user_id,
           customer_email, customer_phone, customer_name,
           status, payment_status, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [
          bookingRef, staffUserId, organizationId, showtime.movie_id, showtime.cinema_id, showtime.screen_id,
          input.showtimeId, totalAmount, 'INR', seatIds.length, 'offline', staffUserId,
          input.customerEmail || null, input.customerPhone || null, input.customerName.trim(),
          'confirmed', 'paid_offline', idempotencyKey,
          JSON.stringify({
            prices: seatPricingResults.map((p, i) => ({ seatId: p.seatId, basePaise: p.basePaise, totalPaise: p.totalPaise, seatType: prices[i]?.seatType })),
            paymentMethod: input.paymentMethod,
            paymentReference: input.paymentReference || null,
            notes: input.notes || null,
            staffUserId,
          }),
        ]
      );
      const booking = bookingResult.rows[0] as MovieBookingRow;

      // Insert booking items
      const items: MovieBookingItemRow[] = [];
      for (const seat of seats) {
        const priceInfo = prices.find(p => p.seatId === seat.id)!;
        const itemResult = await client.query(
          `INSERT INTO movie_booking_items
            (booking_id, showtime_id, seat_id, seat_label, row_label, seat_number, seat_type, seat_category, price, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            booking.id, input.showtimeId, seat.id,
            `${seat.row_label}${seat.seat_number}`, seat.row_label, seat.seat_number,
            seat.seat_type, seat.seat_category, priceInfo.finalPricePaise, 'INR',
          ]
        );
        items.push(itemResult.rows[0] as MovieBookingItemRow);
      }

      // Decrement available seats
      await client.query(
        'UPDATE showtimes SET available_seats = available_seats - $1, booked_seats = booked_seats + $1, updated_at = NOW() WHERE id = $2',
        [seatIds.length, input.showtimeId]
      );

      return { booking, items };
    });

    // ── Record payment order (manual gateway) ─────────────────────────────────

    const orderId = `OFMOV_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    await paymentOrderRepository.create({
      order_id: orderId,
      booking_id: booking.id,
      organization_id: organizationId,
      event_id: null,
      movie_id: showtime.movie_id,
      amount: totalAmount,
      currency: 'INR',
      idempotency_key: `movie_offline_pay_${booking.id}`,
      payment_method: input.paymentMethod,
      financial_snapshot: pricingSnapshot,
    });

    // Update payment_order to mark as COMPLETED with manual gateway
    await paymentOrderRepository.updateFromWebhook(orderId, {
      status: 'COMPLETED',
      payment_method: input.paymentMethod,
      provider_payment_id: input.paymentReference || `manual_${input.paymentMethod.toLowerCase()}`,
    });

    // ── Generate tickets ──────────────────────────────────────────────────────

    const tickets: Array<{
      ticketUuid: string;
      seatLabel: string;
      rowLabel: string;
      seatNumber: number;
      seatType: string;
      signature: string;
      qrData: string;
    }> = [];

    for (const item of bookingItems) {
      const ticketUuid = UniversalTicketService.generateTicketUuid('movie_manager');
      // Bind the signature to the specific showtime to prevent cross-showtime QR replay
      const showtimeStart = new Date(showtime.show_datetime || Date.now()).toISOString();
      const signature = UniversalTicketService.sign({
        domain: 'movie_manager',
        ticketUuid,
        entityId: booking.showtime_id,
        startAt: showtimeStart,
      });

      const qrData = JSON.stringify({
        ref: booking.booking_reference,
        ticket: ticketUuid,
        seat: item.seat_label,
        row: item.row_label,
        showtime: booking.showtime_id,
        domain: 'movie_manager',
        bookingType: 'offline',
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

      tickets.push({
        ticketUuid,
        seatLabel: item.seat_label,
        rowLabel: item.row_label,
        seatNumber: item.seat_number,
        seatType: item.seat_type,
        signature,
        qrData,
      });
    }

    // ── Settlement ────────────────────────────────────────────────────────────

    await this._createSettlement(booking, baseSubtotalPaise);

    await audit(booking.id, 'offline_booking.created', {
      actorType: 'staff', actorId: staffUserId,
      details: {
        showtimeId: input.showtimeId,
        seatIds,
        totalAmount,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        ticketCount: tickets.length,
      },
    });

    logger.info(`[MovieOffline] Created: ${booking.booking_reference}, method=${input.paymentMethod}, amount=${totalAmount}, seats=${seatIds.length}`);

    return {
      booking,
      paymentOrderId: orderId,
      tickets,
    };
  }

  /**
   * Calculate prices for selected seats with price caps (same logic as online).
   */
  private async _calculateSeatPrices(
    showtime: { price: number; currency: string; cinema_id: number },
    seats: Array<{ id: number; row_label: string; seat_number: number; seat_type: string }>,
    cinema: { organization_id: number | null; city: string; state: string }
  ): Promise<MovieSeatPrice[]> {
    const basePrice = showtime.price;

    const priceCap = await moviePriceCapRepository.findApplicable(
      cinema.organization_id, cinema.city, cinema.state, 'all'
    );

    return seats.map(seat => {
      let price = basePrice;

      const premiumMultipliers: Record<string, number> = {
        premium: 1.3,
        sofa: 1.6,
        couple: 1.5,
        wheelchair: 1.0,
      };
      const multiplier = premiumMultipliers[seat.seat_type] || 1.0;
      price = Math.round(basePrice * multiplier);

      let capped = false;
      if (priceCap?.max_price_paise && price > priceCap.max_price_paise) {
        price = priceCap.max_price_paise;
        capped = true;
      }

      return {
        seatId: seat.id,
        basePricePaise: basePrice,
        finalPricePaise: price,
        seatType: seat.seat_type as MovieSeatType,
        capped,
        capReason: capped ? `Price capped at ${priceCap!.max_price_paise} paise` : null,
      };
    });
  }

  /**
   * Post-booking: create settlement record.
   */
  private async _createSettlement(booking: MovieBookingRow, grossAmount: number): Promise<void> {
    const grossAmountPaise = Math.round(grossAmount);
    const orgId = booking.organization_id || 0;
    const configSnapshot = await financialConfigService.getSnapshot(orgId);

    const breakdown = calculateBookingFinancials({
      gross_amount_paise: grossAmountPaise,
      config: configSnapshot,
    });

    const existing = await movieSettlementRepository.findItemByBooking(booking.id);
    if (existing) return;

    const pendingList = await movieSettlementRepository.findPendingByOrg(orgId);
    let settlement = pendingList[0];
    if (!settlement) {
      settlement = await movieSettlementRepository.create({ organization_id: orgId });
    }
    await movieSettlementRepository.addItem({
      settlement_id: settlement.id,
      booking_id: booking.id,
      gross_amount: grossAmount / 100,
      commission_amount: parseFloat((breakdown.commission_paise / 100).toFixed(2)),
      tax_amount: parseFloat((breakdown.gst_on_platform_fee_paise / 100).toFixed(2)),
      net_amount: parseFloat((breakdown.net_payable_to_business_paise / 100).toFixed(2)),
    });
  }

  // ── Public API: get offline bookings for an org ──────────────────────────────

  /**
   * List offline bookings for an organization (date range optional).
   */
  async listOfflineBookings(
    organizationId: number,
    query: { page?: number; pageSize?: number; from?: string; to?: string }
  ): Promise<{ items: MovieBookingRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;

    const whereClauses: string[] = [
      'mb.organization_id = $1',
      'mb.booking_type = $2',
      'mb.deleted_at IS NULL',
    ];
    const params: unknown[] = [organizationId, 'offline'];
    let idx = 3;

    if (query.from) { whereClauses.push(`mb.created_at >= $${idx++}`); params.push(query.from); }
    if (query.to) { whereClauses.push(`mb.created_at < $${idx++}`); params.push(query.to); }

    const where = whereClauses.join(' AND ');

    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM movie_bookings mb WHERE ${where}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    const { rows } = await getPool().query(
      `SELECT mb.* FROM movie_bookings mb WHERE ${where}
       ORDER BY mb.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );

    return {
      items: rows as unknown as MovieBookingRow[],
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  /**
   * Get offline booking details (with related data for the box-office receipt).
   */
  async getOfflineBookingWithDetails(bookingId: number, organizationId: number): Promise<MovieBookingWithDetails | null> {
    const { rows } = await getPool().query(
      `SELECT mb.*
       FROM movie_bookings mb
       WHERE mb.id = $1 AND mb.organization_id = $2 AND mb.booking_type = 'offline'
         AND mb.deleted_at IS NULL
       LIMIT 1`,
      [bookingId, organizationId]
    );
    if (rows.length === 0) return null;

    const booking = rows[0] as MovieBookingRow;
    return movieBookingRepository.getBookingWithDetails(bookingId);
  }
}

export const movieOfflineBookingService = new MovieOfflineBookingService();
