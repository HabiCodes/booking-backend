"use strict";
/**
 * Turf organizer routes — authenticated organizer management.
 * Uses organizerAuthMiddleware (same as event organizer routes).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfOrganizerRoutes = void 0;
const express_1 = require("express");
const organizerAuth_1 = require("../middleware/organizerAuth");
const venueController_1 = require("../controllers/turf/venueController");
const organizerController_1 = require("../controllers/turf/organizerController");
const router = (0, express_1.Router)();
exports.turfOrganizerRoutes = router;
router.use(organizerAuth_1.organizerAuthMiddleware);
// Venues
router.get('/venues', (req, res, next) => (0, venueController_1.listVenues)(req, res, next));
router.post('/venues', (req, res, next) => (0, venueController_1.createVenue)(req, res, next));
router.get('/venues/:venueId', (req, res, next) => (0, venueController_1.getVenue)(req, res, next));
router.patch('/venues/:venueId', (req, res, next) => (0, venueController_1.updateVenue)(req, res, next));
router.delete('/venues/:venueId', (req, res, next) => (0, venueController_1.deleteVenue)(req, res, next));
// Resources
router.post('/venues/:venueId/resources', (req, res, next) => (0, venueController_1.createResource)(req, res, next));
router.get('/venues/:venueId/resources', (req, res, next) => (0, venueController_1.listResources)(req, res, next));
router.get('/venues/:venueId/resources/:resourceId', (req, res, next) => (0, venueController_1.getResource)(req, res, next));
router.patch('/venues/:venueId/resources/:resourceId', (req, res, next) => (0, venueController_1.updateResource)(req, res, next));
// Slots
router.get('/venues/:venueId/resources/:resourceId/slots', (req, res, next) => (0, venueController_1.listSlots)(req, res, next));
router.post('/venues/:venueId/resources/:resourceId/slots', (req, res, next) => (0, venueController_1.generateSlots)(req, res, next));
// Bookings
router.get('/bookings', (req, res, next) => (0, organizerController_1.listOrgBookings)(req, res, next));
// Coupons
router.get('/coupons', (req, res, next) => (0, organizerController_1.listCoupons)(req, res, next));
router.post('/coupons', (req, res, next) => (0, organizerController_1.createCoupon)(req, res, next));
// Settlements
router.get('/settlements', (req, res, next) => (0, organizerController_1.listSettlements)(req, res, next));
