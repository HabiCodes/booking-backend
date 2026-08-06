/**
 * Upload controller — handles multipart image uploads for events and banners.
 *
 * Endpoints:
 *  POST /api/admin/uploads/event        — event banner / thumbnail / gallery
 *  POST /api/admin/uploads/banner       — ticket advertisement / hero banner
 */
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { saveUpload } from '../services/uploadService';
import { AppError } from '../middleware/errorHandler';
import { AdminRequest } from '../middleware/adminAuth';
import { UploadRequest } from '../middleware/upload';

export async function uploadEventImage(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const upReq = req as UploadRequest;
    const file = upReq.upload;
    if (!file) { throw new AppError('No file uploaded', 400); }

    const saved = await saveUpload(
      file.buffer,
      'events',
      config.uploads.maxEventImageBytes
    );

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
}

export async function uploadBannerImage(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
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

    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
}
