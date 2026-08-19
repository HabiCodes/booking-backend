/**
 * Movie Offline Booking Controller — box-office / counter booking.
 *
 * Endpoints:
 *   POST /api/organizer/v1/movies/offline-bookings   — create offline booking
 *   GET  /api/organizer/v1/movies/offline-bookings   — list offline bookings
 *   GET  /api/organizer/v1/movies/offline-bookings/:id — get booking details
 *
 * All routes require organizerAuthMiddleware + movie manager permissions.
 */

import { Response, NextFunction } from 'express';
import { movieOfflineBookingService } from '../services/movieOfflineBookingService';
import { OrganizerRequest } from '../middleware/organizerAuth';

// ── Create offline booking ────────────────────────────────────────────────────

export async function createOfflineBooking(req: OrganizerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const staffUserId = req.organizerUser!.id;
    const organizationId = req.organizerUser!.organizationId;

    const seatIds: number[] = Array.isArray(req.body?.seatIds)
      ? (req.body.seatIds as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];

    if (!req.body?.showtimeId || !Number.isFinite(Number(req.body.showtimeId))) {
      res.status(400).json({ success: false, message: 'showtimeId is required' });
      return;
    }
    if (seatIds.length === 0) {
      res.status(400).json({ success: false, message: 'seatIds[] is required' });
      return;
    }
    if (!req.body?.customerName?.trim()) {
      res.status(400).json({ success: false, message: 'customerName is required' });
      return;
    }
    if (!req.body?.paymentMethod) {
      res.status(400).json({ success: false, message: 'paymentMethod (CASH, UPI, or CARD) is required' });
      return;
    }

    // Build idempotency key from sorted seat IDs
    const seatIdsSignature = seatIds.sort((a, b) => a - b).join(',');

    const result = await movieOfflineBookingService.createOfflineBooking(staffUserId, organizationId, {
      showtimeId: Number(req.body.showtimeId),
      seatIds,
      customerName: req.body.customerName,
      customerEmail: req.body.customerEmail,
      customerPhone: req.body.customerPhone,
      paymentMethod: req.body.paymentMethod.toUpperCase(),
      paymentReference: req.body.paymentReference,
      notes: req.body.notes,
      seatIdsSignature,
    });

    res.status(201).json({
      success: true,
      data: {
        booking: result.booking,
        paymentOrderId: result.paymentOrderId,
        tickets: result.tickets,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── List offline bookings ─────────────────────────────────────────────────────

export async function listOfflineBookings(req: OrganizerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizationId = req.organizerUser!.organizationId;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 25;

    const result = await movieOfflineBookingService.listOfflineBookings(organizationId, {
      page,
      pageSize,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    res.json({
      success: true,
      data: result.items,
      pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages },
    });
  } catch (err) {
    next(err);
  }
}

// ── Get single offline booking ────────────────────────────────────────────────

export async function getOfflineBooking(req: OrganizerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const organizationId = req.organizerUser!.organizationId;
    const bookingId = parseInt(req.params.id, 10);

    if (!Number.isFinite(bookingId)) {
      res.status(400).json({ success: false, message: 'Invalid booking ID' });
      return;
    }

    const details = await movieOfflineBookingService.getOfflineBookingWithDetails(bookingId, organizationId);
    if (!details) {
      res.status(404).json({ success: false, message: 'Offline booking not found' });
      return;
    }

    res.json({ success: true, data: details });
  } catch (err) {
    next(err);
  }
}
