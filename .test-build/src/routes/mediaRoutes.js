"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventMediaRouter = exports.adminMediaRouter = void 0;
const express_1 = require("express");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const mediaController_1 = require("../controllers/mediaController");
const router = (0, express_1.Router)();
exports.adminMediaRouter = router;
router.use(adminAuth_1.adminAuthMiddleware);
// ── Media library ─────────────────────────────────────────────────────────────
router.post('/', (0, permissions_1.requirePermission)('media:write'), (0, audit_1.auditMiddleware)('media.upload', {
    entityType: 'media',
    extra: (req) => ({
        filename: req.body?.filename ?? null,
        mime_type: req.body?.mime_type ?? null,
    }),
}), (req, res, next) => (0, mediaController_1.uploadMedia)(req, res, next));
router.get('/', (0, permissions_1.requirePermission)('media:read'), (req, res, next) => (0, mediaController_1.listMedia)(req, res, next));
router.get('/:id', (0, permissions_1.requirePermission)('media:read'), (req, res, next) => (0, mediaController_1.getMedia)(req, res, next));
router.patch('/:id', (0, permissions_1.requirePermission)('media:write'), (0, audit_1.auditMiddleware)('media.update', { entityType: 'media' }), (req, res, next) => (0, mediaController_1.updateMedia)(req, res, next));
router.delete('/:id', (0, permissions_1.requirePermission)('media:delete'), (0, audit_1.auditMiddleware)('media.delete', { entityType: 'media' }), (req, res, next) => (0, mediaController_1.deleteMedia)(req, res, next));
router.post('/:id/restore', (0, permissions_1.requirePermission)('media:write'), (0, audit_1.auditMiddleware)('media.restore', { entityType: 'media' }), (req, res, next) => (0, mediaController_1.restoreMedia)(req, res, next));
// ── Event-media binding ───────────────────────────────────────────────────────
// Attached under /api/admin/events/:eventId/media (see adminProtectedRoutes)
// Pattern is registered here as nested under /events/:eventId/media.
const eventMediaRouter = (0, express_1.Router)({ mergeParams: true });
exports.eventMediaRouter = eventMediaRouter;
eventMediaRouter.use(adminAuth_1.adminAuthMiddleware);
eventMediaRouter.post('/', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.media.attach', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventId,
}), (req, res, next) => (0, mediaController_1.attachEventMedia)(req, res, next));
eventMediaRouter.get('/', (0, permissions_1.requirePermission)('events:read'), (req, res, next) => (0, mediaController_1.listEventMedia)(req, res, next));
eventMediaRouter.post('/reorder', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.media.reorder', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventId,
}), (req, res, next) => (0, mediaController_1.reorderEventMedia)(req, res, next));
eventMediaRouter.patch('/:eventMediaId', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.media.update', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventMediaId,
}), (req, res, next) => (0, mediaController_1.updateEventMedia)(req, res, next));
eventMediaRouter.delete('/:eventMediaId', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.media.detach', {
    entityType: 'event_media',
    entityId: (req) => req.params.eventMediaId,
}), (req, res, next) => {
    // Rewrite :eventMediaId → :mediaId for the controller signature
    req.params.mediaId = req.params.eventMediaId;
    return (0, mediaController_1.detachEventMedia)(req, res, next);
});
