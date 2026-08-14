import { Router } from 'express';
import {
  adminStats,
  adminBookings,
  adminRecentTickets,
  adminAuditLogs,
  adminListAdmins,
  adminMe,
  adminUsers,
  adminCancelBooking,
} from '../controllers/adminController';
import {
  adminListRefunds,
  adminGetRefund,
  adminCreateRefund,
} from '../controllers/adminRefundController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { adminOrganizerController } from '../controllers/adminOrganizerController';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import { adminEventRouter } from './eventRoutes';
import bannerRoutes from './bannerRoutes';
import uploadRoutes from './uploadRoutes';
import { adminMediaRouter, eventMediaRouter } from './mediaRoutes';

const router = Router();

// All routes below require a valid admin JWT
router.use(adminAuthMiddleware);

// ── Self ─────────────────────────────────────────────────────────────────────
router.get('/me', (req: AdminRequest, res, next) => adminMe(req, res, next));

// ── Dashboard analytics (any authenticated admin) ───────────────────────────
router.get(
  '/stats',
  requirePermission('analytics:read'),
  (req: AdminRequest, res, next) => adminStats(req, res, next)
);

// ── Bookings ─────────────────────────────────────────────────────────────────
router.get(
  '/bookings',
  requirePermission('bookings:read'),
  (req: AdminRequest, res, next) => adminBookings(req, res, next)
);
router.get(
  '/recent-tickets',
  requirePermission('bookings:read'),
  (req: AdminRequest, res, next) => adminRecentTickets(req, res, next)
);
router.post(
  '/bookings/:id/cancel',
  requirePermission('bookings:cancel'),
  auditMiddleware('booking.cancel'),
  (req: AdminRequest, res, next) => adminCancelBooking(req, res, next)
);

// ── Users ────────────────────────────────────────────────────────────────────
router.get(
  '/users',
  requirePermission('users:read'),
  (req: AdminRequest, res, next) => adminUsers(req, res, next)
);

// ── Admins (team management) ────────────────────────────────────────────────
router.get(
  '/admins',
  requirePermission('admins:read'),
  (req: AdminRequest, res, next) => adminListAdmins(req, res, next)
);

// ── Audit log viewer ─────────────────────────────────────────────────────────
router.get(
  '/audit-logs',
  requirePermission('audit:read'),
  (req: AdminRequest, res, next) => adminAuditLogs(req, res, next)
);

// ── Event CRUD under /api/admin/events ──────────────────────────────────────
router.use('/events', adminEventRouter);

// ── Banner management under /api/admin/banners ──────────────────────────────
router.use('/banners', bannerRoutes);

// ── File uploads under /api/admin/uploads ───────────────────────────────────
router.use('/uploads', uploadRoutes);

// ── Media library under /api/admin/media ─────────────────────────────────────
router.use('/media', adminMediaRouter);

// ── Event-media binding under /api/admin/events/:eventId/media ───────────────
router.use('/events/:eventId/media', eventMediaRouter);

// ── Organizer Management (Super Admin) ──────────────────────────────────────
router.get('/organizer-applications',
  requirePermission('organizer:applications:read'),
  adminOrganizerController.listOrganizerApplications
);
router.get('/organizer-applications/:id',
  requirePermission('organizer:applications:read'),
  adminOrganizerController.getOrganizerApplication
);
router.post('/organizer-applications/:id/review',
  requirePermission('organizer:applications:approve'),
  auditMiddleware('organizer.application.review'),
  adminOrganizerController.reviewOrganizerApplication
);

// Organizations
router.get('/organizations',
  requirePermission('organizer:applications:read'),
  adminOrganizerController.listOrganizations
);
router.get('/organizations/:id',
  requirePermission('organizer:applications:read'),
  adminOrganizerController.getOrganization
);
router.patch('/organizations/:id',
  requirePermission('organizer:applications:approve'),
  adminOrganizerController.updateOrganization
);
router.post('/organizations/:id/deactivate',
  requirePermission('organizer:applications:approve'),
  adminOrganizerController.deactivateOrganization
);
router.post('/organizations/:id/reactivate',
  requirePermission('organizer:applications:approve'),
  adminOrganizerController.reactivateOrganization
);

// Managers
router.get('/managers',
  requirePermission('organizer:staff:read'),
  adminOrganizerController.listManagers
);
router.get('/managers/:id',
  requirePermission('organizer:staff:read'),
  adminOrganizerController.getManager
);
router.post('/managers',
  requirePermission('organizer:staff:write'),
  auditMiddleware('organizer.manager.create'),
  adminOrganizerController.createManager
);
router.patch('/managers/:id',
  requirePermission('organizer:staff:write'),
  auditMiddleware('organizer.manager.update'),
  adminOrganizerController.updateManager
);
router.post('/managers/:id/deactivate',
  requirePermission('organizer:staff:write'),
  adminOrganizerController.deactivateManager
);
router.post('/managers/:id/reactivate',
  requirePermission('organizer:staff:write'),
  adminOrganizerController.reactivateManager
);

// Refund management
router.get('/refunds',
  requirePermission('payment:read'),
  auditMiddleware('admin.refund.list'),
  adminListRefunds
);
router.get('/refunds/:id',
  requirePermission('payment:read'),
  auditMiddleware('admin.refund.view'),
  adminGetRefund
);
router.post('/refunds',
  requirePermission('payment:write'),
  auditMiddleware('admin.refund.create'),
  adminCreateRefund
);

export default router;
