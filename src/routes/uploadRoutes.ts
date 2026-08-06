import { Router } from 'express';
import express from 'express';
import { uploadEventImage, uploadBannerImage } from '../controllers/uploadController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';
import { jsonUploadMiddleware } from '../middleware/upload';

const router = Router();

router.use(adminAuthMiddleware);

// Event images (banner, thumbnail, gallery)
router.post(
  '/event',
  requirePermission('uploads:write'),
  express.json({ limit: '15mb' }),
  jsonUploadMiddleware,
  auditMiddleware('upload.event', {
    entityType: 'upload',
    extra: (req) => ({
      filename: (req.body as { filename?: string } | undefined)?.filename ?? null,
      category: (req.body as { category?: string } | undefined)?.category ?? null,
    }),
  }),
  (req: AdminRequest, res, next) => uploadEventImage(req, res, next)
);

// Banner images
router.post(
  '/banner',
  requirePermission('uploads:write'),
  express.json({ limit: '15mb' }),
  jsonUploadMiddleware,
  auditMiddleware('upload.banner', {
    entityType: 'upload',
    extra: (req) => ({
      filename: (req.body as { filename?: string } | undefined)?.filename ?? null,
      scope: (req.body as { scope?: string } | undefined)?.scope ?? null,
    }),
  }),
  (req: AdminRequest, res, next) => uploadBannerImage(req, res, next)
);

export default router;
