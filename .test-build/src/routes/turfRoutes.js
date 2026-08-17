"use strict";
/**
 * Turf routes — customer-facing public + authenticated endpoints.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfCustomerRoutes = void 0;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const errorHandler_1 = require("../middleware/errorHandler");
const turfVenueService_1 = require("../services/turfVenueService");
const turfReviewRepository_1 = require("../repositories/turfReviewRepository");
const turfBookingService_1 = require("../services/turfBookingService");
const turfBookingRepository_1 = require("../repositories/turfBookingRepository");
const turfAvailabilityEngine_1 = require("../services/turfAvailabilityEngine");
const router = (0, express_1.Router)();
exports.turfCustomerRoutes = router;
// ── Public browsing ─────────────────────────────────────────────────────────
router.get('/grounds', async (req, res, next) => {
    try {
        const result = await turfVenueService_1.turfVenueService.findPublic(req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
router.get('/grounds/:venueId', async (req, res, next) => {
    try {
        const venue = await turfVenueService_1.turfVenueService.getById(Number(req.params.venueId));
        res.json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
});
router.get('/grounds/:venueId/reviews', async (req, res, next) => {
    try {
        const reviews = await turfReviewRepository_1.turfReviewRepository.findByVenue(Number(req.params.venueId));
        res.json({ success: true, data: reviews });
    }
    catch (err) {
        next(err);
    }
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
            throw new errorHandler_1.AppError('Valid resourceId is required', 400);
        }
        if (!date) {
            throw new errorHandler_1.AppError('date (YYYY-MM-DD) is required', 400);
        }
        const result = await turfAvailabilityEngine_1.availabilityEngine.getCustomerAvailability(resourceId, date);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
// ── Authenticated customer routes ───────────────────────────────────────────
router.use(auth_1.authMiddleware);
router.post('/bookings', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const result = await turfBookingService_1.turfBookingService.createBooking(userId, req.body, { actorId: userId, actorType: 'customer' });
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
router.get('/my/bookings', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const result = await turfBookingRepository_1.turfBookingRepository.findByUser(userId, req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
router.get('/my/bookings/:id', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const booking = await turfBookingRepository_1.turfBookingRepository.findDetail(Number(req.params.id));
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        if (booking.user_id !== userId)
            throw new errorHandler_1.AppError('Not your booking', 403);
        res.json({ success: true, data: booking });
    }
    catch (err) {
        next(err);
    }
});
router.post('/my/bookings/:id/cancel', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        await turfBookingService_1.turfBookingService.cancelBooking(Number(req.params.id), userId, req.body.reason ?? null, { actorId: userId, actorType: 'customer' });
        res.json({ success: true, message: 'Booking cancelled' });
    }
    catch (err) {
        next(err);
    }
});
router.post('/my/bookings/:id/checkin', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const result = await turfBookingService_1.turfBookingService.checkIn(Number(req.params.id), { actorId: userId, actorType: 'customer' });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
router.post('/my/bookings/:bookingId/review', async (req, res, next) => {
    try {
        const userId = req.user?.id;
        const { rating, review } = req.body;
        const bookingId = Number(req.params.bookingId);
        const booking = await turfBookingRepository_1.turfBookingRepository.findById(bookingId);
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        if (booking.user_id !== userId)
            throw new errorHandler_1.AppError('Not your booking', 403);
        if (booking.status !== 'confirmed' && booking.status !== 'completed' && booking.status !== 'checked_in') {
            throw new errorHandler_1.AppError('Can only review after booking', 400);
        }
        const result = await turfBookingService_1.turfBookingService.createReview(userId, booking.venue_id, bookingId, rating, review);
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
});
