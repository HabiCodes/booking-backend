import { Request, Response, NextFunction } from 'express';
import { organizerAuthMiddleware, OrganizerRequest } from '../middleware/organizerAuth';
import { promotionService } from '../services/promotionService';
import { AppError } from '../middleware/errorHandler';

// Public package endpoints (no auth)
export async function listActivePackages(_req: Request, res: Response, next: NextFunction) {
  try {
    const packages = await promotionService.listActivePackages();
    res.json({ success: true, data: packages });
  } catch (err) { next(err); }
}

export async function getPackage(req: Request, res: Response, next: NextFunction) {
  try {
    const pkg = await promotionService.getPackage(Number(req.params.id));
    if (!pkg) throw new AppError('Package not found', 404);
    res.json({ success: true, data: pkg });
  } catch (err) { next(err); }
}

// Organizer campaign endpoints
export async function listCampaigns(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const result = await promotionService.listCampaigns(orgId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getCampaign(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const campaign = await promotionService.getCampaign(Number(req.params.id), orgId);
    if (!campaign) throw new AppError('Campaign not found', 404);
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function createCampaign(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const organizerId = req.organizerUser!.id;
    const campaign = await promotionService.createCampaign(req.body, orgId, organizerId);
    res.status(201).json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function updateCampaign(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    // Updates are limited — most fields are immutable after creation (config_snapshot)
    // Allow updating name and notes only
    const orgId = req.organizerUser!.organizationId;
    const campaign = await promotionService.getCampaign(Number(req.params.id), orgId);
    if (!campaign) throw new AppError('Campaign not found', 404);
    // For now, just return the campaign (full edit will be in a later slice)
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function createCampaignPayment(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const { customerEmail, customerPhone, customerName } = req.body;
    const result = await promotionService.createCampaignPayment(
      Number(req.params.id), orgId, customerEmail, customerPhone, customerName
    );
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function activateCampaign(req: Request, res: Response, next: NextFunction) {
  // Called by payment webhook — no auth required (but should be internal)
  try {
    const campaign = await promotionService.activateCampaign(Number(req.params.id));
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function cancelCampaign(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const campaign = await promotionService.cancelCampaign(Number(req.params.id), orgId);
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
}

export async function getCampaignAnalytics(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const analytics = await promotionService.getCampaignAnalytics(Number(req.params.id), orgId);
    res.json({ success: true, data: analytics });
  } catch (err) { next(err); }
}
