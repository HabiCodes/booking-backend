import { Request, Response, NextFunction } from 'express';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { promotionService } from '../services/promotionService';
import { AppError } from '../middleware/errorHandler';

// ── Admin Package Management ─────────────────────────────────────────────────

export async function listPackagesAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const result = await promotionService.listPackages(req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function createPackageAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = Number((req as any).admin?.id);
    const pkg = await promotionService.createPackage({ ...req.body, created_by_admin_id: adminId });
    res.status(201).json({ success: true, data: pkg });
  } catch (err) { next(err); }
}

export async function updatePackageAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const pkg = await promotionService.updatePackage(Number(req.params.id), req.body);
    if (!pkg) throw new AppError('Package not found', 404);
    res.json({ success: true, data: pkg });
  } catch (err) { next(err); }
}

export async function deletePackageAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    await promotionService.deletePackage(Number(req.params.id));
    res.json({ success: true });
  } catch (err) { next(err); }
}

// ── Admin Campaign Management ────────────────────────────────────────────────

export async function listAllCampaignsAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await promotionService.listAllCampaignsAdmin(req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function approveCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const campaign = await promotionService.approveCampaign(Number(req.params.id));
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function rejectCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body;
    const campaign = await promotionService.rejectCampaign(Number(req.params.id), reason);
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function pauseCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body;
    const campaign = await promotionService.pauseCampaign(Number(req.params.id), reason);
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function resumeCampaign(req: Request, res: Response, next: NextFunction) {
  try {
    const campaign = await promotionService.resumeCampaign(Number(req.params.id));
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function getPlatformAnalyticsAdmin(_req: Request, res: Response, next: NextFunction) {
  try {
    const analytics = await promotionService.getPlatformAnalytics();
    res.json({ success: true, data: analytics });
  } catch (err) { next(err); }
}
