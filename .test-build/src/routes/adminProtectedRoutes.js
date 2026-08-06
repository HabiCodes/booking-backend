"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const adminController_1 = require("../controllers/adminController");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const eventRoutes_1 = require("./eventRoutes");
const bannerRoutes_1 = __importDefault(require("./bannerRoutes"));
const uploadRoutes_1 = __importDefault(require("./uploadRoutes"));
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
exports.default = router;
