"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminController_1 = require("../controllers/adminController");
const adminRefundController_1 = require("../controllers/adminRefundController");
const adminAuth_1 = require("../middleware/adminAuth");
const adminOrganizerController_1 = require("../controllers/adminOrganizerController");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const eventRoutes_1 = require("./eventRoutes");
const bannerRoutes_1 = __importDefault(require("./bannerRoutes"));
const uploadRoutes_1 = __importDefault(require("./uploadRoutes"));
const mediaRoutes_1 = require("./mediaRoutes");
const router = (0, express_1.Router)();
// All routes below require a valid admin JWT
router.use(adminAuth_1.adminAuthMiddleware);
// ── Self ─────────────────────────────────────────────────────────────────────
router.get('/me', (req, res, next) => (0, adminController_1.adminMe)(req, res, next));
// ── Dashboard analytics (any authenticated admin) ───────────────────────────
router.get('/stats', (0, permissions_1.requirePermission)('analytics:read'), (req, res, next) => (0, adminController_1.adminStats)(req, res, next));
// ── Bookings ─────────────────────────────────────────────────────────────────
router.get('/bookings', (0, permissions_1.requirePermission)('bookings:read'), (req, res, next) => (0, adminController_1.adminBookings)(req, res, next));
router.get('/recent-tickets', (0, permissions_1.requirePermission)('bookings:read'), (req, res, next) => (0, adminController_1.adminRecentTickets)(req, res, next));
router.post('/bookings/:id/cancel', (0, permissions_1.requirePermission)('bookings:cancel'), (0, audit_1.auditMiddleware)('booking.cancel'), (req, res, next) => (0, adminController_1.adminCancelBooking)(req, res, next));
// ── Users ────────────────────────────────────────────────────────────────────
router.get('/users', (0, permissions_1.requirePermission)('users:read'), (req, res, next) => (0, adminController_1.adminUsers)(req, res, next));
// ── Admins (team management) ────────────────────────────────────────────────
router.get('/admins', (0, permissions_1.requirePermission)('admins:read'), (req, res, next) => (0, adminController_1.adminListAdmins)(req, res, next));
// ── Audit log viewer ─────────────────────────────────────────────────────────
router.get('/audit-logs', (0, permissions_1.requirePermission)('audit:read'), (req, res, next) => (0, adminController_1.adminAuditLogs)(req, res, next));
// ── Event CRUD under /api/admin/events ──────────────────────────────────────
router.use('/events', eventRoutes_1.adminEventRouter);
// ── Banner management under /api/admin/banners ──────────────────────────────
router.use('/banners', bannerRoutes_1.default);
// ── File uploads under /api/admin/uploads ───────────────────────────────────
router.use('/uploads', uploadRoutes_1.default);
// ── Media library under /api/admin/media ─────────────────────────────────────
router.use('/media', mediaRoutes_1.adminMediaRouter);
// ── Event-media binding under /api/admin/events/:eventId/media ───────────────
router.use('/events/:eventId/media', mediaRoutes_1.eventMediaRouter);
// ── Organizer Management (Super Admin) ──────────────────────────────────────
router.get('/organizer-applications', (0, permissions_1.requirePermission)('organizer:applications:read'), adminOrganizerController_1.adminOrganizerController.listOrganizerApplications);
router.get('/organizer-applications/:id', (0, permissions_1.requirePermission)('organizer:applications:read'), adminOrganizerController_1.adminOrganizerController.getOrganizerApplication);
router.post('/organizer-applications/:id/review', (0, permissions_1.requirePermission)('organizer:applications:approve'), (0, audit_1.auditMiddleware)('organizer.application.review'), adminOrganizerController_1.adminOrganizerController.reviewOrganizerApplication);
// Organizations
router.get('/organizations', (0, permissions_1.requirePermission)('organizer:applications:read'), adminOrganizerController_1.adminOrganizerController.listOrganizations);
router.get('/organizations/:id', (0, permissions_1.requirePermission)('organizer:applications:read'), adminOrganizerController_1.adminOrganizerController.getOrganization);
router.patch('/organizations/:id', (0, permissions_1.requirePermission)('organizer:applications:approve'), adminOrganizerController_1.adminOrganizerController.updateOrganization);
router.post('/organizations/:id/deactivate', (0, permissions_1.requirePermission)('organizer:applications:approve'), adminOrganizerController_1.adminOrganizerController.deactivateOrganization);
router.post('/organizations/:id/reactivate', (0, permissions_1.requirePermission)('organizer:applications:approve'), adminOrganizerController_1.adminOrganizerController.reactivateOrganization);
// Managers
router.get('/managers', (0, permissions_1.requirePermission)('organizer:staff:read'), adminOrganizerController_1.adminOrganizerController.listManagers);
router.get('/managers/:id', (0, permissions_1.requirePermission)('organizer:staff:read'), adminOrganizerController_1.adminOrganizerController.getManager);
router.post('/managers', (0, permissions_1.requirePermission)('organizer:staff:write'), (0, audit_1.auditMiddleware)('organizer.manager.create'), adminOrganizerController_1.adminOrganizerController.createManager);
router.patch('/managers/:id', (0, permissions_1.requirePermission)('organizer:staff:write'), (0, audit_1.auditMiddleware)('organizer.manager.update'), adminOrganizerController_1.adminOrganizerController.updateManager);
router.post('/managers/:id/deactivate', (0, permissions_1.requirePermission)('organizer:staff:write'), adminOrganizerController_1.adminOrganizerController.deactivateManager);
router.post('/managers/:id/reactivate', (0, permissions_1.requirePermission)('organizer:staff:write'), adminOrganizerController_1.adminOrganizerController.reactivateManager);
// Refund management
router.get('/refunds', (0, permissions_1.requirePermission)('payment:read'), (0, audit_1.auditMiddleware)('admin.refund.list'), adminRefundController_1.adminListRefunds);
router.get('/refunds/:id', (0, permissions_1.requirePermission)('payment:read'), (0, audit_1.auditMiddleware)('admin.refund.view'), adminRefundController_1.adminGetRefund);
router.post('/refunds', (0, permissions_1.requirePermission)('payment:write'), (0, audit_1.auditMiddleware)('admin.refund.create'), adminRefundController_1.adminCreateRefund);
exports.default = router;
