/**
 * Promotion routes — customer/public-facing (packages) + authenticated (campaigns).
 */

import { Router } from 'express';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  listActivePackages, getPackage as getPackageController,
  listCampaigns, getCampaign, createCampaign, updateCampaign, cancelCampaign,
  createCampaignPayment, activateCampaign, getCampaignAnalytics,
} from '../controllers/promotionController';
import {
  listPackagesAdmin, createPackageAdmin, updatePackageAdmin, deletePackageAdmin,
  listAllCampaignsAdmin, approveCampaign, rejectCampaign, pauseCampaign, resumeCampaign, getPlatformAnalyticsAdmin,
} from '../controllers/promotionAdminController';
import { promotionService } from '../services/promotionService';

const router = Router();

// ── Public: Promotion Packages ───────────────────────────────────────────────

router.get('/packages', async (req, res, next) => {
  try {
    const result = await promotionService.listPackages({ isActive: true, search: req.query.search as string });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/packages/:id', async (req, res, next) => {
  try {
    const pkg = await promotionService.getPackage(Number(req.params.id));
    if (!pkg) throw new Error('Package not found');
    res.json({ success: true, data: pkg });
  } catch (err) { next(err); }
});

// ── Public: Sponsored Results (intended for the API consumer) ─────────────────

router.get('/sponsored', async (req, res, next) => {
  try {
    const { placement, category, locationKey, entityType, limit } = req.query;
    const result = await promotionService.deliverSponsoredResults({
      placement: placement as 'HOME_HERO' | 'CATEGORY_FEED' | 'SEARCH_FEED' | 'NEAR_YOU' | 'LISTING_CARD' | 'DETAIL_PAGE',
      category: category as string,
      locationKey: locationKey as string,
      entityType: entityType as string,
      limit: limit ? Number(limit) : 5,
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.post('/clicks', async (req, res, next) => {
  try {
    const { campaignId, impressionId, userSessionId } = req.body;
    if (!campaignId) throw new Error('campaignId required');
    await promotionService.trackClick(campaignId, impressionId, userSessionId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Organizer: Campaign Management ───────────────────────────────────────────

const organizerRouter = Router();
organizerRouter.use(organizerAuthMiddleware);

organizerRouter.get('/campaigns', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    if (!orgId) throw new Error('Unauthorized');
    const result = await promotionService.listCampaigns(orgId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

organizerRouter.get('/campaigns/:id', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    const campaign = await promotionService.getCampaign(Number(req.params.id), orgId);
    if (!campaign) throw new Error('Campaign not found');
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
});

organizerRouter.post('/campaigns', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    const organizerId = (req as any).organizer?.id;
    const campaign = await promotionService.createCampaign(req.body, orgId, organizerId);
    res.status(201).json({ success: true, data: campaign });
  } catch (err) { next(err); }
});

organizerRouter.post('/campaigns/:id/payment', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    const { customerEmail, customerPhone, customerName } = req.body;
    const result = await promotionService.createCampaignPayment(
      Number(req.params.id), orgId, customerEmail, customerPhone, customerName
    );
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

organizerRouter.post('/campaigns/:id/activate', async (req, res, next) => {
  try {
    // Called by payment webhook — no body needed
    const campaign = await promotionService.activateCampaign(Number(req.params.id));
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
});

organizerRouter.post('/campaigns/:id/cancel', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    const campaign = await promotionService.cancelCampaign(Number(req.params.id), orgId);
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
});

organizerRouter.get('/campaigns/:id/analytics', async (req, res, next) => {
  try {
    const orgId = (req as any).organizer?.organizationId;
    const analytics = await promotionService.getCampaignAnalytics(Number(req.params.id), orgId);
    res.json({ success: true, data: analytics });
  } catch (err) { next(err); }
});

// ── Organizer: Package Management ───────────────────────────────────────────

organizerRouter.get('/packages', async (req, res, next) => {
  try {
    const result = await promotionService.listActivePackages();
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ── Admin: Package Management ───────────────────────────────────────────────

const adminRouter = Router();
adminRouter.use(adminAuthMiddleware);

adminRouter.get('/packages', listPackagesAdmin);
adminRouter.post('/packages', createPackageAdmin);
adminRouter.patch('/packages/:id', updatePackageAdmin);
adminRouter.delete('/packages/:id', deletePackageAdmin);

adminRouter.get('/campaigns', listAllCampaignsAdmin);
adminRouter.patch('/campaigns/:id/approve', approveCampaign);
adminRouter.patch('/campaigns/:id/reject', rejectCampaign);
adminRouter.patch('/campaigns/:id/pause', pauseCampaign);
adminRouter.patch('/campaigns/:id/resume', resumeCampaign);
adminRouter.get('/analytics', getPlatformAnalyticsAdmin);

export { router as promotionPublicRoutes, organizerRouter as promotionOrganizerRoutes, adminRouter as promotionAdminRoutes };
