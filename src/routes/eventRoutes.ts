import { Router } from 'express';
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

export default router;