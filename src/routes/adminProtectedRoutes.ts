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
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import { adminEventRouter } from './eventRoutes';
import bannerRoutes from './bannerRoutes';
import uploadRoutes from './uploadRoutes';

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

export default router;
