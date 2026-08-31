import { Router, Response, NextFunction } from 'express';
import {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  getEventTicketTiers,
  getEventSeats,
  createEventSeats,
} from '../controllers/organizerEventController';
import {
  listZones,
  getZone as organizerGetZone,
  adminCreateZone as createZone,
  adminUpdateZone as updateZone,
  adminDeleteZone as deleteZone,
} from '../controllers/eventZoneController';
import { organizerAuthMiddleware, OrganizerRequest } from '../middleware/organizerAuth';
import { requireOrganizerPermission, requireOwner } from '../middleware/organizerPermissions';
import { organizerWriteRateLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(organizerAuthMiddleware);

// Apply write rate limiting to mutating routes
type OrganizerHandler = (req: OrganizerRequest, res: Response, next: NextFunction) => any;
const withWriteRateLimit = (handler: OrganizerHandler): OrganizerHandler[] =>
  [organizerWriteRateLimiter, handler as unknown as OrganizerHandler];

// Permission check helper for event routes
function checkEventPermission(req: OrganizerRequest, action: 'read' | 'write' | 'delete'): void {
  const perms: Record<string, boolean> = req.organizerUser?.permissions || {};
  const permKey = `organizer:events:${action}`;
  if (!perms[permKey]) {
    throw new AppError(`Missing permission: ${permKey}`, 403);
  }
}

// List and read — both owners and managers can view events
router.get('/', (req: OrganizerRequest, res, next) => {
  try {
    checkEventPermission(req, 'read');
    listEvents(req, res, next);
  } catch (err) { next(err); }
});

router.get('/:id', (req: OrganizerRequest, res, next) => {
  try {
    checkEventPermission(req, 'read');
    getEvent(req, res, next);
  } catch (err) { next(err); }
});

router.get('/:id/ticket-tiers', requireOrganizerPermission('organizer:events:read'), getEventTicketTiers);
router.get('/:id/seats', requireOrganizerPermission('organizer:events:read'), getEventSeats);

// ── Zone routes ──────────────────────────────────────────────────────────────
router.get('/:id/zones', requireOrganizerPermission('organizer:events:read'), listZones);
router.get('/:id/zones/:zoneId', requireOrganizerPermission('organizer:events:read'), organizerGetZone);
router.post('/:id/zones', ...withWriteRateLimit(requireOrganizerPermission('organizer:events:write')), createZone);
router.put('/zones/:zoneId', ...withWriteRateLimit(requireOrganizerPermission('organizer:events:write')), updateZone);
router.delete('/zones/:zoneId', ...withWriteRateLimit(requireOrganizerPermission('organizer:events:write')), deleteZone);

// Create — owners always; managers with write permission
router.post('/', ...withWriteRateLimit((req: OrganizerRequest, res, next) => {
  try {
    if (req.organizerUser!.role !== 'owner') {
      checkEventPermission(req, 'write');
    }
    createEvent(req, res, next);
  } catch (err) { next(err); }
}));

// Update — owners always; managers with write permission
router.patch('/:id', ...withWriteRateLimit((req: OrganizerRequest, res, next) => {
  try {
    if (req.organizerUser!.role !== 'owner') {
      checkEventPermission(req, 'write');
    }
    updateEvent(req, res, next);
  } catch (err) { next(err); }
}));

// Delete — owners only for events
router.delete('/:id', ...withWriteRateLimit(requireOwner), deleteEvent);

// Seats — owners can create; managers need write permission
router.post('/:id/seats', ...withWriteRateLimit((req: OrganizerRequest, res, next) => {
  try {
    if (req.organizerUser!.role !== 'owner') {
      checkEventPermission(req, 'write');
    }
    createEventSeats(req, res, next);
  } catch (err) { next(err); }
}));

export default router;