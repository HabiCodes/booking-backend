"use strict";
/**
 * Turf admin controller — platform admin oversight.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAllVenues = listAllVenues;
exports.updateVenueStatus = updateVenueStatus;
exports.listAllBookings = listAllBookings;
exports.getBookingDetail = getBookingDetail;
exports.listVenueReviews = listVenueReviews;
const errorHandler_1 = require("../../middleware/errorHandler");
const turfVenueRepository_1 = require("../../repositories/turfVenueRepository");
const turfBookingRepository_1 = require("../../repositories/turfBookingRepository");
const turfReviewRepository_1 = require("../../repositories/turfReviewRepository");
const turfVenueService_1 = require("../../services/turfVenueService");
async function listAllVenues(req, res, next) {
    try {
        const result = await turfVenueRepository_1.turfVenueRepository.findAll({
            page: Number(req.query.page) || 1,
            pageSize: Number(req.query.pageSize) || 25,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function updateVenueStatus(req, res, next) {
    try {
        const { status } = req.body;
        if (!['pending', 'approved', 'suspended'].includes(status)) {
            throw new errorHandler_1.AppError('Invalid status', 400);
        }
        const venue = await turfVenueService_1.turfVenueService.update(Number(req.params.venueId), { status });
        res.json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
}
async function listAllBookings(req, res, next) {
    try {
        const orgId = Number(req.query.organizationId || 0);
        const result = await turfBookingRepository_1.turfBookingRepository.findByOrganization(orgId, {
            status: req.query.status,
            page: Number(req.query.page) || 1,
            pageSize: Number(req.query.pageSize) || 25,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function getBookingDetail(req, res, next) {
    try {
        const booking = await turfBookingRepository_1.turfBookingRepository.findDetail(Number(req.params.id));
        if (!booking)
            throw new errorHandler_1.AppError('Booking not found', 404);
        res.json({ success: true, data: booking });
    }
    catch (err) {
        next(err);
    }
}
async function listVenueReviews(req, res, next) {
    try {
        const reviews = await turfReviewRepository_1.turfReviewRepository.findByVenue(Number(req.params.venueId));
        res.json({ success: true, data: reviews });
    }
    catch (err) {
        next(err);
    }
}
