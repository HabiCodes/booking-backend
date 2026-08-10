"use strict";
/**
 * Turf booking controller — customer-facing booking operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBooking = createBooking;
exports.getMyBookings = getMyBookings;
exports.getBooking = getBooking;
exports.cancelBooking = cancelBooking;
exports.checkInBooking = checkInBooking;
exports.createReview = createReview;
const turfBookingService_1 = require("../../services/turfBookingService");
const turfBookingRepository_1 = require("../../repositories/turfBookingRepository");
const errorHandler_1 = require("../../middleware/errorHandler");
async function createBooking(req, res, next) {
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
}
async function getMyBookings(req, res, next) {
    try {
        const userId = req.user?.id;
        const result = await turfBookingRepository_1.turfBookingRepository.findByUser(userId, req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function getBooking(req, res, next) {
    try {
        const userId = req.user?.id;
        const booking = await turfBookingRepository_1.turfBookingRepository.findDetail(Number(req.params.id));
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        res.json({ success: true, data: booking });
    }
    catch (err) {
        next(err);
    }
}
async function cancelBooking(req, res, next) {
    try {
        const userId = req.user?.id;
        await turfBookingService_1.turfBookingService.cancelBooking(Number(req.params.id), userId, req.body.reason ?? null, { actorId: userId, actorType: 'customer' });
        res.json({ success: true, message: 'Booking cancelled' });
    }
    catch (err) {
        next(err);
    }
}
async function checkInBooking(req, res, next) {
    try {
        const userId = req.user?.id;
        const result = await turfBookingService_1.turfBookingService.checkIn(Number(req.params.id), { actorId: userId, actorType: 'customer' });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function createReview(req, res, next) {
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
}
