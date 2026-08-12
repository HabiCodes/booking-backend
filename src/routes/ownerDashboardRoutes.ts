/**
 * Owner Dashboard routes — revenue and business-growth analytics.
 *
 * Authorization: organizerAuthMiddleware (owner or manager of the org).
 * All endpoints are scoped to req.organizerUser!.organizationId.
 */

import { Router, type Request, type Response } from 'express';
import { organizerAuthMiddleware, type OrganizerRequest } from '../middleware/organizerAuth';
import { ownerDashboardService } from '../services/ownerDashboardService';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// All routes require a valid organizer JWT
router.use(organizerAuthMiddleware);

/**
 * GET /api/owner/dashboard
 *
 * Query params:
 *   from  — ISO date (default: 30 days ago)
 *   to    — ISO date (default: today)
 */
router.get('/dashboard', async (req: OrganizerRequest, res: Response, next: Function) => {
  try {
    const user = req.organizerUser;
    if (!user) {
      throw new AppError('Unauthorized', 401);
    }

    const from = (req.query.from as string) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = (req.query.to as string) ?? new Date().toISOString().slice(0, 10);

    const data = await ownerDashboardService.getDashboard(user.organizationId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/owner/settlements
 *
 * Query params:
 *   limit — max records (default 50, max 200)
 */
router.get('/settlements', async (req: OrganizerRequest, res: Response, next: Function) => {
  try {
    const user = req.organizerUser;
    if (!user) {
      throw new AppError('Unauthorized', 401);
    }

    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const settlements = await ownerDashboardService.getSettlementHistory(user.organizationId, limit);
    res.json({ success: true, data: settlements });
  } catch (err) {
    next(err);
  }
});

export default router;
