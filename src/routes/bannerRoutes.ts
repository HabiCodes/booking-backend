import { Router } from 'express';
import express from 'express';
import {
  listBanners,
  getBanner,
  activateBanner,
  deactivateBanner,
  updateBanner,
  deleteBanner,
  createBannerFromUpload,
  getActiveTicketAd,
} from '../controllers/bannerController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import { jsonUploadMiddleware } from '../middleware/upload';

const router = Router();

router.use(adminAuthMiddleware);

// Read (banners:read or analytics:read for ticket ads)
router.get('/', requirePermission('banners:read'), (req: AdminRequest, res, next) => listBanners(req, res, next));
router.get('/active-ticket-ad', (req: AdminRequest, res, next) => getActiveTicketAd(req, res, next));
router.get('/:id', requirePermission('banners:read'), (req: AdminRequest, res, next) => getBanner(req, res, next));

// Create
router.post(
  '/',
  requirePermission('banners:write'),
  express.json({ limit: '15mb' }),
  jsonUploadMiddleware,
  auditMiddleware('banner.create'),
  (req: AdminRequest, res, next) => createBannerFromUpload(req, res, next)
);

// Update
router.patch(
  '/:id',
  requirePermission('banners:write'),
  express.json({ limit: '64kb' }),
  auditMiddleware('banner.update'),
  (req: AdminRequest, res, next) => updateBanner(req, res, next)
);

// Delete
router.delete(
  '/:id',
  requirePermission('banners:delete'),
  auditMiddleware('banner.delete'),
  (req: AdminRequest, res, next) => deleteBanner(req, res, next)
);

// Activation toggle
router.put(
  '/:id/activate',
  requirePermission('banners:write'),
  auditMiddleware('banner.activate'),
  (req: AdminRequest, res, next) => activateBanner(req, res, next)
);
router.put(
  '/:id/deactivate',
  requirePermission('banners:write'),
  auditMiddleware('banner.deactivate'),
  (req: AdminRequest, res, next) => deactivateBanner(req, res, next)
);

export default router;
