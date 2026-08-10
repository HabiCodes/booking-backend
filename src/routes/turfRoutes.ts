/**
 * Turf routes — customer-facing public + authenticated endpoints.
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { turfVenueService } from '../services/turfVenueService';
import { turfReviewRepository } from '../repositories/turfReviewRepository';
import { turfBookingService } from '../services/turfBookingService';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { availabilityEngine } from '../services/turfAvailabilityEngine';

const router = Router();

// ── Public browsing ─────────────────────────────────────────────────────────

router.get('/grounds', async (req, res, next) => {
  try {
    const result = await turfVenueService.findPublic(req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/grounds/:venueId', async (req, res, next) => {
  try {
    const venue = await turfVenueService.getById(Number(req.params.venueId));
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
});

router.get('/grounds/:venueId/reviews', async (req, res, next) => {
  try {
    const reviews = await turfReviewRepository.findByVenue(Number(req.params.venueId));
    res.json({ success: true, data: reviews });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/turf/resources/:resourceId/availability?date=YYYY-MM-DD
 *
 * PUBLIC — no authentication required.
 *
 * Returns real-time slot availability for a resource on a given date.
 * The Availability Engine is the single source of truth:
 *   - Reclaims expired locks before reading
 *   - Checks active holds, bookings, blocked periods, and unit status
 *   - Returns each slot's real-time state (available / held / booked / blocked / unavailable)
 *
 * Query params:
 *   date (required): YYYY-MM-DD
 *
 * Response: ResourceAvailabilityResponse with slots array and summary counts.
 */
router.get('/resources/:resourceId/availability', async (req, res, next) => {
  try {
    const resourceId = Number(req.params.resourceId);
    const date = String(req.query.date || '').trim();

    if (!resourceId || resourceId <= 0) {
      throw new AppError('Valid resourceId is required', 400);
    }
    if (!date) {
      throw new AppError('date (YYYY-MM-DD) is required', 400);
    }

    const result = await availabilityEngine.getCustomerAvailability(resourceId, date);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── Authenticated customer routes ───────────────────────────────────────────

router.use(authMiddleware);

router.post('/bookings', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);
    const result = await turfBookingService.createBooking(userId, req.body, { actorId: userId, actorType: 'customer' });
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/my/bookings', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    const result = await turfBookingRepository.findByUser(userId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/my/bookings/:id', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    const booking = await turfBookingRepository.findDetail(Number(req.params.id));
    if (!booking) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
});

router.post('/my/bookings/:id/cancel', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    await turfBookingService.cancelBooking(Number(req.params.id), userId, req.body.reason ?? null, { actorId: userId, actorType: 'customer' });
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) { next(err); }
});

router.post('/my/bookings/:id/checkin', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    const result = await turfBookingService.checkIn(Number(req.params.id), { actorId: userId, actorType: 'customer' });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.post('/my/bookings/:bookingId/review', async (req, res, next) => {
  try {
    const userId = (req as any).user?.id;
    const { rating, review } = req.body;
    const bookingId = Number(req.params.bookingId);
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    if (booking.status !== 'confirmed' && booking.status !== 'completed' && booking.status !== 'checked_in') {
      throw new AppError('Can only review after booking', 400);
    }
    const result = await turfBookingService.createReview(userId, booking.venue_id, bookingId, rating, review);
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
});

export { router as turfCustomerRoutes };
