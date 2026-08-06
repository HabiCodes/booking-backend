/**
 * Banner controller — admin-facing CRUD + activate/deactivate endpoints.
 *
 * RBAC: all endpoints require adminAuthMiddleware (see adminProtectedRoutes).
 * Authorisation is handled by the admin role system (moderator+ can manage banners).
 */
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { bannerService } from '../services/bannerService';
import { saveUpload } from '../services/uploadService';
import { AppError } from '../middleware/errorHandler';
import { AdminRequest } from '../middleware/adminAuth';
import { UploadRequest } from '../middleware/upload';

export async function listBanners(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const placement = (req.query.placement as string | undefined) ?? undefined;
    const isActive = req.query.is_active !== undefined
      ? req.query.is_active === 'true'
      : undefined;
    const page = parseInt((req.query.page as string | undefined) ?? '1', 10) || 1;
    const pageSize = parseInt((req.query.page_size as string | undefined) ?? '20', 10) || 20;

    const result = await bannerService.listBanners({
      placement: placement as any,
      isActive,
      page,
      pageSize,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getBanner(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) { throw new AppError('Invalid banner ID', 400); }

    const banner = await bannerService.getBanner(id);
    if (!banner) { throw new AppError('Banner not found', 404); }

    res.json({ success: true, data: banner });
  } catch (err) {
    next(err);
  }
}

export async function activateBanner(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) { throw new AppError('Invalid banner ID', 400); }

    const banner = await bannerService.activateBanner(id);
    if (!banner) { throw new AppError('Banner not found', 404); }

    res.json({ success: true, data: banner, message: 'Banner activated' });
  } catch (err) {
    next(err);
  }
}

export async function deactivateBanner(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) { throw new AppError('Invalid banner ID', 400); }

    const banner = await bannerService.deactivateBanner(id);
    if (!banner) { throw new AppError('Banner not found or already deactivated', 404); }

    res.json({ success: true, data: banner, message: 'Banner deactivated' });
  } catch (err) {
    next(err);
  }
}

export async function updateBanner(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) { throw new AppError('Invalid banner ID', 400); }

    const { alt_text, link_url, priority } = req.body ?? {};
    const banner = await bannerService.updateBanner(id, {
      alt_text,
      link_url,
      priority,
    });
    if (!banner) { throw new AppError('Banner not found', 404); }

    res.json({ success: true, data: banner });
  } catch (err) {
    next(err);
  }
}

export async function deleteBanner(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) { throw new AppError('Invalid banner ID', 400); }

    const deleted = await bannerService.softDeleteBanner(id);
    if (!deleted) { throw new AppError('Banner not found', 404); }

    res.json({ success: true, message: 'Banner deleted' });
  } catch (err) {
    next(err);
  }
}

export async function createBannerFromUpload(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.admin) { throw new AppError('Unauthorized', 401); }

    const upReq = req as UploadRequest;
    const file = upReq.upload;
    if (!file) { throw new AppError('No file uploaded', 400); }

    const saved = await saveUpload(
      file.buffer,
      'banners',
      config.uploads.maxFileSizeBytes,
      {
        minWidth: config.uploads.bannerMinWidth,
        minHeight: config.uploads.bannerMinHeight,
      }
    );

    const placementRaw = (req.body?.placement as string | undefined) ?? 'ticket_advertisement';
    const placement = placementRaw as 'ticket_advertisement' | 'homepage_hero' | 'event_thumbnail';
    if (!['ticket_advertisement', 'homepage_hero', 'event_thumbnail'].includes(placement)) {
      throw new AppError(`Invalid placement: ${placement}`, 400);
    }

    const result = await bannerService.createBanner({
      imageUrl: saved.url,
      mimeType: saved.mimeType,
      fileSizeBytes: saved.sizeBytes,
      width: saved.width,
      height: saved.height,
      uploadedBy: req.admin.id,
      placement,
      altText: (req.body?.alt_text as string | null | undefined) ?? null,
      linkUrl: (req.body?.link_url as string | null | undefined) ?? null,
      priority: typeof req.body?.priority === 'number' ? req.body.priority : 0,
    });

    res.status(201).json({ success: true, data: result.banner });
  } catch (err) {
    next(err);
  }
}

export async function getActiveTicketAd(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const banner = await bannerService.getActiveTicketAd();
    res.json({ success: true, data: banner });
  } catch (err) {
    next(err);
  }
}
