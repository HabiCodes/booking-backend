import { Router } from 'express';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import {
  uploadMedia,
  listMedia,
  getMedia,
  updateMedia,
  deleteMedia,
  restoreMedia,
  attachEventMedia,
  listEventMedia,
  updateEventMedia,
  detachEventMedia,
  reorderEventMedia,
} from '../controllers/mediaController';

const router = Router();

router.use(adminAuthMiddleware);

// ── Media library ─────────────────────────────────────────────────────────────

router.post(
  '/',
  requirePermission('media:write'),
  auditMiddleware('media.upload', {
    entityType: 'media',
    extra: (req) => ({
      filename: (req.body as { filename?: string } | undefined)?.filename ?? null,
      mime_type: (req.body as { mime_type?: string } | undefined)?.mime_type ?? null,
    }),
  }),
  (req: AdminRequest, res, next) => uploadMedia(req, res, next)
);

router.get(
  '/',
  requirePermission('media:read'),
  (req: AdminRequest, res, next) => listMedia(req, res, next)
);

router.get(
  '/:id',
  requirePermission('media:read'),
  (req: AdminRequest, res, next) => getMedia(req, res, next)
);

router.patch(
  '/:id',
  requirePermission('media:write'),
  auditMiddleware('media.update', { entityType: 'media' }),
  (req: AdminRequest, res, next) => updateMedia(req, res, next)
);

router.delete(
  '/:id',
  requirePermission('media:delete'),
  auditMiddleware('media.delete', { entityType: 'media' }),
  (req: AdminRequest, res, next) => deleteMedia(req, res, next)
);

router.post(
  '/:id/restore',
  requirePermission('media:write'),
  auditMiddleware('media.restore', { entityType: 'media' }),
  (req: AdminRequest, res, next) => restoreMedia(req, res, next)
);

// ── Event-media binding ───────────────────────────────────────────────────────

// Attached under /api/admin/events/:eventId/media (see adminProtectedRoutes)
// Pattern is registered here as nested under /events/:eventId/media.

const eventMediaRouter = Router({ mergeParams: true });
eventMediaRouter.use(adminAuthMiddleware);

eventMediaRouter.post(
  '/',
  requirePermission('events:write'),
  auditMiddleware('event.media.attach', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventId,
  }),
  (req: AdminRequest, res, next) => attachEventMedia(req, res, next)
);

eventMediaRouter.get(
  '/',
  requirePermission('events:read'),
  (req: AdminRequest, res, next) => listEventMedia(req, res, next)
);

eventMediaRouter.post(
  '/reorder',
  requirePermission('events:write'),
  auditMiddleware('event.media.reorder', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventId,
  }),
  (req: AdminRequest, res, next) => reorderEventMedia(req, res, next)
);

eventMediaRouter.patch(
  '/:eventMediaId',
  requirePermission('events:write'),
  auditMiddleware('event.media.update', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventMediaId,
  }),
  (req: AdminRequest, res, next) => updateEventMedia(req, res, next)
);

eventMediaRouter.delete(
  '/:eventMediaId',
  requirePermission('events:write'),
  auditMiddleware('event.media.detach', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventMediaId,
  }),
  (req: AdminRequest, res, next) => {
    // Rewrite :eventMediaId → :mediaId for the controller signature
    req.params.mediaId = req.params.eventMediaId;
    return detachEventMedia(req, res, next);
  }
);

// Allow event-media binding via the media-style URL:
//   POST   /api/admin/events/:eventId/media                — attach
//   GET    /api/admin/events/:eventId/media                — list
//   PATCH  /api/admin/events/:eventId/media/:eventMediaId — update binding
//   POST   /api/admin/events/:eventId/media/reorder        — reorder
//   DELETE /api/admin/events/:eventId/media/:eventMediaId  — detach
//
// We mount this router on a parent path with /events/:eventId/media.

export { router as adminMediaRouter, eventMediaRouter };