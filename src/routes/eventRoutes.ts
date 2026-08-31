import { Router } from 'express';
import {
  listZones,
  getZone,
  adminCreateZone,
  adminUpdateZone,
  adminDeleteZone,
  adminGetAvailability,
} from '../controllers/eventZoneController';
import {
  listEvents,
  getEvent,
  getStats,
  getFeaturedEvents,
  getCategories,
  getCities,
  adminListEvents,
  adminCreateEvent,
  adminUpdateEvent,
  adminDeleteEvent,
  adminRestoreEvent,
  adminPublishEvent,
  adminHideEvent,
  adminCancelEvent,
  adminSetFeatured,
} from '../controllers/eventController';
import {
  submitForReview,
  approveEvent,
  rejectEvent,
  unpublishEvent,
  showEvent,
  archiveEvent,
  restoreEvent,
  cancelEvent,
  getEventHistory,
  listPendingReview,
} from '../controllers/eventLifecycleController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';

const router = Router();

// ── Public routes ────────────────────────────────────────────────────────────
router.get('/', listEvents);
router.get('/featured', getFeaturedEvents);
router.get('/categories', getCategories);
router.get('/cities', getCities);
router.get('/:id/stats', getStats);
router.get('/:id', getEvent);

// ── Public zone routes ────────────────────────────────────────────────────────
router.get('/:id/zones', listZones);
router.get('/:id/zones/:zoneId', getZone);

// ── Admin routes (mounted on admin protected router) ─────────────────────────
export const adminEventRouter = Router();
adminEventRouter.use(adminAuthMiddleware);

// Read
adminEventRouter.get(
  '/',
  requirePermission('events:read'),
  (req: AdminRequest, res, next) => adminListEvents(req, res, next)
);

// Create / Update / Delete
adminEventRouter.post(
  '/',
  requirePermission('events:write'),
  auditMiddleware('event.create'),
  (req: AdminRequest, res, next) => adminCreateEvent(req, res, next)
);
adminEventRouter.put(
  '/:id',
  requirePermission('events:write'),
  auditMiddleware('event.update'),
  (req: AdminRequest, res, next) => adminUpdateEvent(req, res, next)
);
adminEventRouter.patch(
  '/:id',
  requirePermission('events:write'),
  auditMiddleware('event.update'),
  (req: AdminRequest, res, next) => adminUpdateEvent(req, res, next)
);
adminEventRouter.delete(
  '/:id',
  requirePermission('events:delete'),
  auditMiddleware('event.delete'),
  (req: AdminRequest, res, next) => adminDeleteEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/restore',
  requirePermission('events:write'),
  auditMiddleware('event.restore'),
  (req: AdminRequest, res, next) => adminRestoreEvent(req, res, next)
);

// Status changes
adminEventRouter.post(
  '/:id/publish',
  requirePermission('events:publish'),
  auditMiddleware('event.publish'),
  (req: AdminRequest, res, next) => adminPublishEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/hide',
  requirePermission('events:publish'),
  auditMiddleware('event.hide'),
  (req: AdminRequest, res, next) => adminHideEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/cancel',
  requirePermission('events:publish'),
  auditMiddleware('event.cancel'),
  (req: AdminRequest, res, next) => adminCancelEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/featured',
  requirePermission('events:feature'),
  auditMiddleware('event.feature'),
  (req: AdminRequest, res, next) => adminSetFeatured(req, res, next)
);

// ── Lifecycle workflow routes (Migration 014) ──────────────────────────────────
adminEventRouter.post(
  '/:id/submit-for-review',
  requirePermission('events:write'),
  auditMiddleware('event.submit_for_review'),
  (req: AdminRequest, res, next) => submitForReview(req, res, next)
);
adminEventRouter.post(
  '/:id/approve',
  requirePermission('events:publish'),
  auditMiddleware('event.approve'),
  (req: AdminRequest, res, next) => approveEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/reject',
  requirePermission('events:publish'),
  auditMiddleware('event.reject'),
  (req: AdminRequest, res, next) => rejectEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/unpublish',
  requirePermission('events:publish'),
  auditMiddleware('event.unpublish'),
  (req: AdminRequest, res, next) => unpublishEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/show',
  requirePermission('events:publish'),
  auditMiddleware('event.show'),
  (req: AdminRequest, res, next) => showEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/archive',
  requirePermission('events:write'),
  auditMiddleware('event.archive'),
  (req: AdminRequest, res, next) => archiveEvent(req, res, next)
);
adminEventRouter.post(
  '/:id/restore',
  requirePermission('events:write'),
  auditMiddleware('event.restore'),
  (req: AdminRequest, res, next) => restoreEvent(req, res, next)
);

// ── Zone CRUD (admin) ────────────────────────────────────────────────────────
adminEventRouter.post(
  '/:id/zones',
  requirePermission('events:write'),
  auditMiddleware('event.zone.create'),
  (req: AdminRequest, res, next) => adminCreateZone(req, res, next)
);
adminEventRouter.put(
  '/zones/:zoneId',
  requirePermission('events:write'),
  auditMiddleware('event.zone.update'),
  (req: AdminRequest, res, next) => adminUpdateZone(req, res, next)
);
adminEventRouter.delete(
  '/zones/:zoneId',
  requirePermission('events:write'),
  auditMiddleware('event.zone.delete'),
  (req: AdminRequest, res, next) => adminDeleteZone(req, res, next)
);
adminEventRouter.get(
  '/:id/zones/availability',
  requirePermission('events:read'),
  (req: AdminRequest, res, next) => adminGetAvailability(req, res, next)
);

// ── Review queue ──────────────────────────────────────────────────────────────
adminEventRouter.get(
  '/pending-review',
  requirePermission('events:read'),
  (req: AdminRequest, res, next) => listPendingReview(req, res, next)
);

// ── Status history ─────────────────────────────────────────────────────────────
adminEventRouter.get(
  '/:id/history',
  requirePermission('audit:read'),
  (req: AdminRequest, res, next) => getEventHistory(req, res, next)
);

export default router;
