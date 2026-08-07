"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminEventRouter = void 0;
const express_1 = require("express");
const eventController_1 = require("../controllers/eventController");
const eventLifecycleController_1 = require("../controllers/eventLifecycleController");
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
// ── Lifecycle workflow routes (Migration 014) ──────────────────────────────────
// Each transition is audited. The event_status_history insert is handled
// by EventLifecycleService (appended atomically with the status change).
exports.adminEventRouter.post('/:id/submit-for-review', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.submit_for_review'), (req, res, next) => (0, eventLifecycleController_1.submitForReview)(req, res, next));
exports.adminEventRouter.post('/:id/approve', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.approve'), (req, res, next) => (0, eventLifecycleController_1.approveEvent)(req, res, next));
exports.adminEventRouter.post('/:id/reject', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.reject'), (req, res, next) => (0, eventLifecycleController_1.rejectEvent)(req, res, next));
exports.adminEventRouter.post('/:id/unpublish', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.unpublish'), (req, res, next) => (0, eventLifecycleController_1.unpublishEvent)(req, res, next));
exports.adminEventRouter.post('/:id/show', (0, permissions_1.requirePermission)('events:publish'), (0, audit_1.auditMiddleware)('event.show'), (req, res, next) => (0, eventLifecycleController_1.showEvent)(req, res, next));
exports.adminEventRouter.post('/:id/archive', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.archive'), (req, res, next) => (0, eventLifecycleController_1.archiveEvent)(req, res, next));
exports.adminEventRouter.post('/:id/restore', (0, permissions_1.requirePermission)('events:write'), (0, audit_1.auditMiddleware)('event.restore'), (req, res, next) => (0, eventLifecycleController_1.restoreEvent)(req, res, next));
// ── Review queue ──────────────────────────────────────────────────────────────
exports.adminEventRouter.get('/pending-review', (0, permissions_1.requirePermission)('events:read'), (req, res, next) => (0, eventLifecycleController_1.listPendingReview)(req, res, next));
// ── Status history ─────────────────────────────────────────────────────────────
exports.adminEventRouter.get('/:id/history', (0, permissions_1.requirePermission)('audit:read'), (req, res, next) => (0, eventLifecycleController_1.getEventHistory)(req, res, next));
exports.default = router;
