"use strict";
/**
 * Turf admin routes — platform admin oversight.
 * Uses adminAuthMiddleware + requirePermission middleware.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfAdminRoutes = void 0;
const express_1 = require("express");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const adminController_1 = require("../controllers/turf/adminController");
const router = (0, express_1.Router)();
exports.turfAdminRoutes = router;
router.use(adminAuth_1.adminAuthMiddleware);
router.get('/venues', (0, permissions_1.requirePermission)('organizer:venues:read'), (req, res, next) => (0, adminController_1.listAllVenues)(req, res, next));
router.patch('/venues/:venueId/status', (0, permissions_1.requirePermission)('organizer:venues:write'), (req, res, next) => (0, adminController_1.updateVenueStatus)(req, res, next));
router.get('/bookings', (0, permissions_1.requirePermission)('organizer:bookings:read'), (req, res, next) => (0, adminController_1.listAllBookings)(req, res, next));
router.get('/bookings/:id', (0, permissions_1.requirePermission)('organizer:bookings:read'), (req, res, next) => (0, adminController_1.getBookingDetail)(req, res, next));
router.get('/venues/:venueId/reviews', (0, permissions_1.requirePermission)('organizer:venues:read'), (req, res, next) => (0, adminController_1.listVenueReviews)(req, res, next));
