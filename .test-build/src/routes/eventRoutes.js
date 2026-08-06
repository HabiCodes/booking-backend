"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminEventRouter = void 0;
const express_1 = require("express");
const eventController_1 = require("../controllers/eventController");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const router = (0, express_1.Router)();
// ── Public routes ────────────────────────────────────────────────────────────
router.get('/', eventController_1.listEvents);
router.get('/featured', eventController_1.getFeaturedEvents);
router.get('/categories', eventController_1.getCategories);
router.get('/cities', eventController_1.getCities);
router.get('/:id/stats', eventController_1.getStats);
router.get('/:id', eventController_1.getEvent);
// ── Admin routes (mounted on admin protected router) ─────────────────────────
exports.adminEventRouter = (0, express_1.Router)();
exports.adminEventRouter.use(adminAuth_1.adminAuthMiddleware);
// Read
exports.adminEventRouter.get('/', (0, permissions_1.requirePermission)('events:read'), (req, res, next) => (0, eventController_1.adminListEvents)(req, res, next));
// Create / Update / Delete
exports.adminEventRouter.post('/', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.create'), (req, res, next) => (0, eventController_1.adminCreateEvent)(req, res, next));
exports.adminEventRouter.put('/:id', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.update'), (req, res, next) => (0, eventController_1.adminUpdateEvent)(req, res, next));
exports.adminEventRouter.patch('/:id', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.update'), (req, res, next) => (0, eventController_1.adminUpdateEvent)(req, res, next));
exports.adminEventRouter.delete('/:id', (0, permissions_1.requirePermission)('events:delete'), (0, audit_1.auditMiddleware)('event.delete'), (req, res, next) => (0, eventController_1.adminDeleteEvent)(req, res, next));
exports.adminEventRouter.post('/:id/restore', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.restore'), (req, res, next) => (0, eventController_1.adminRestoreEvent)(req, res, next));
// Status changes
exports.adminEventRouter.post('/:id/publish', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.publish'), (req, res, next) => (0, eventController_1.adminPublishEvent)(req, res, next));
exports.adminEventRouter.post('/:id/hide', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.hide'), (req, res, next) => (0, eventController_1.adminHideEvent)(req, res, next));
exports.adminEventRouter.post('/:id/cancel', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.cancel'), (req, res, next) => (0, eventController_1.adminCancelEvent)(req, res, next));
exports.adminEventRouter.post('/:id/featured', (0, permissions_1.requirePermission)('events:feature'), (0, audit_1.auditMiddleware)('event.feature'), (req, res, next) => (0, eventController_1.adminSetFeatured)(req, res, next));
exports.default = router;
