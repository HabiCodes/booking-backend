/**
 * Turf admin routes — platform admin oversight.
 * Uses adminAuthMiddleware + requirePermission middleware.
 */

import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import {
  listAllVenues,
  updateVenueStatus,
  listAllBookings,
  getBookingDetail,
  listVenueReviews,
} from '../controllers/turf/adminController';

const router = Router();

router.use(adminAuthMiddleware);

router.get('/venues',
  requirePermission('organizer:venues:read'),
  (req, res, next) => listAllVenues(req, res, next)
);

router.patch('/venues/:venueId/status',
  requirePermission('organizer:venues:write'),
  (req, res, next) => updateVenueStatus(req, res, next)
);

router.get('/bookings',
  requirePermission('organizer:bookings:read'),
  (req, res, next) => listAllBookings(req, res, next)
);

router.get('/bookings/:id',
  requirePermission('organizer:bookings:read'),
  (req, res, next) => getBookingDetail(req, res, next)
);

router.get('/venues/:venueId/reviews',
  requirePermission('organizer:venues:read'),
  (req, res, next) => listVenueReviews(req, res, next)
);

export { router as turfAdminRoutes };
