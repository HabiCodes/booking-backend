/**
 * Turf organizer routes — authenticated organizer management.
 * Uses organizerAuthMiddleware + granular permission checks.
 *
 * All routes are scoped to the caller's organization_id.
 * Owners get full access. Managers need explicit turf permissions.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requireOrganizerPermission,
  requireOwner,
} from '../middleware/organizerPermissions';
import { organizerAuthMiddleware, type OrganizerRequest } from '../middleware/organizerAuth';
import { organizerWriteRateLimiter } from '../middleware/rateLimiter';
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
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(organizerAuthMiddleware);

// Permission check helper for turf routes
function checkTurfPermission(req: OrganizerRequest, action: 'read' | 'write' | 'delete'): void {
  const perms: Record<string, boolean> = req.organizerUser?.permissions || {};
  const permKey = `organizer:turf:${action}`;
  if (!perms[permKey]) {
    throw new AppError(`Missing permission: ${permKey}`, 403);
  }
}

type OrganizerHandler = (req: OrganizerRequest, res: Response, next: NextFunction) => any;

const withWriteRate = (handler: OrganizerHandler): OrganizerHandler[] =>
  [organizerWriteRateLimiter, handler as unknown as OrganizerHandler];

// ── Venues ────────────────────────────────────────────────────────────────────

router.get('/venues', requireOrganizerPermission('organizer:turf:read'), listVenues);

router.post('/venues', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    createVenue(req, res, next);
  } catch (err) { next(err); }
}));

router.get('/venues/:venueId', requireOrganizerPermission('organizer:turf:read'), getVenue);

router.patch('/venues/:venueId', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    updateVenue(req, res, next);
  } catch (err) { next(err); }
}));

router.delete('/venues/:venueId', requireOwner, deleteVenue);

// ── Resources ─────────────────────────────────────────────────────────────────

router.post('/venues/:venueId/resources', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    createResource(req, res, next);
  } catch (err) { next(err); }
}));

router.get('/venues/:venueId/resources', requireOrganizerPermission('organizer:turf:read'), listResources);

router.get('/venues/:venueId/resources/:resourceId', requireOrganizerPermission('organizer:turf:read'), getResource);

router.patch('/venues/:venueId/resources/:resourceId', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    updateResource(req, res, next);
  } catch (err) { next(err); }
}));

// ── Slots ─────────────────────────────────────────────────────────────────────

router.get('/venues/:venueId/resources/:resourceId/slots', requireOrganizerPermission('organizer:turf:read'), listSlots);

router.post('/venues/:venueId/resources/:resourceId/slots', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    generateSlots(req, res, next);
  } catch (err) { next(err); }
}));

// ── Bookings ──────────────────────────────────────────────────────────────────

router.get('/bookings', requireOrganizerPermission('organizer:turf:read'), listOrgBookings);

// ── Coupons ────────────────────────────────────────────────────────────────────

router.get('/coupons', requireOrganizerPermission('organizer:turf:read'), listCoupons);

router.post('/coupons', ...withWriteRate((req: OrganizerRequest, res: Response, next: NextFunction) => {
  try {
    if (req.organizerUser!.role !== 'owner') checkTurfPermission(req, 'write');
    createCoupon(req, res, next);
  } catch (err) { next(err); }
}));

// ── Settlements (read-only, owner only) ──────────────────────────────────────

router.get('/settlements', requireOwner, listSettlements);

export { router as turfOrganizerRoutes };
