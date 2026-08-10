/**
 * Turf organizer routes — authenticated organizer management.
 * Uses organizerAuthMiddleware (same as event organizer routes).
 */

import { Router } from 'express';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';
import {
  listVenues,
  createVenue,
  getVenue,
  updateVenue,
  deleteVenue,
  createResource,
  listResources,
  getResource,
  updateResource,
  listSlots,
  generateSlots,
} from '../controllers/turf/venueController';
import {
  listOrgBookings,
  listOrgVenues,
  createOrgVenue,
  listCoupons,
  createCoupon,
  listSettlements,
} from '../controllers/turf/organizerController';

const router = Router();

router.use(organizerAuthMiddleware);

// Venues
router.get('/venues', (req, res, next) => listVenues(req, res, next));
router.post('/venues', (req, res, next) => createVenue(req, res, next));
router.get('/venues/:venueId', (req, res, next) => getVenue(req, res, next));
router.patch('/venues/:venueId', (req, res, next) => updateVenue(req, res, next));
router.delete('/venues/:venueId', (req, res, next) => deleteVenue(req, res, next));

// Resources
router.post('/venues/:venueId/resources', (req, res, next) => createResource(req, res, next));
router.get('/venues/:venueId/resources', (req, res, next) => listResources(req, res, next));
router.get('/venues/:venueId/resources/:resourceId', (req, res, next) => getResource(req, res, next));
router.patch('/venues/:venueId/resources/:resourceId', (req, res, next) => updateResource(req, res, next));

// Slots
router.get('/venues/:venueId/resources/:resourceId/slots', (req, res, next) => listSlots(req, res, next));
router.post('/venues/:venueId/resources/:resourceId/slots', (req, res, next) => generateSlots(req, res, next));

// Bookings
router.get('/bookings', (req, res, next) => listOrgBookings(req, res, next));

// Coupons
router.get('/coupons', (req, res, next) => listCoupons(req, res, next));
router.post('/coupons', (req, res, next) => createCoupon(req, res, next));

// Settlements
router.get('/settlements', (req, res, next) => listSettlements(req, res, next));

export { router as turfOrganizerRoutes };
