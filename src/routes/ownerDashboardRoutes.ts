/**
 * Owner Dashboard routes — revenue, business-growth, event, and settlement analytics.
 *
 * Authorization: organizerAuthMiddleware (owner or manager of the org) + requireOwner.
 * All endpoints are scoped to req.organizerUser!.organizationId.
 *
 * CROSS-DOMAIN: This router now serves turf, event, and movie analytics endpoints.
 */

import { Router, type Request, type Response } from 'express';
import { organizerAuthMiddleware, type OrganizerRequest } from '../middleware/organizerAuth';
import { ownerDashboardService } from '../services/ownerDashboardService';
import { AppError } from '../middleware/errorHandler';
import { requireOwner } from '../middleware/organizerPermissionMiddleware';

const router = Router();

// All routes require a valid organizer JWT
router.use(organizerAuthMiddleware);

// All owner dashboard routes require owner role
router.use(requireOwner);

// ── Main Dashboard ─────────────────────────────────────────────────────────

/**
 * GET /api/owner/dashboard
 *
 * Cross-domain aggregation: turf + events + movies.
 * Returns unified overview, domain summaries, trends, resources, customer segments, and insights.
 *
 * Query params:
 *   from  — ISO date YYYY-MM-DD (default: 30 days ago)
 *   to    — ISO date YYYY-MM-DD (default: today, inclusive)
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

// ── Unified Settlement History ───────────────────────────────────────────────

/**
 * GET /api/owner/settlements
 *
 * Cross-domain settlement history: turf + events + movie.
 * Returns unified settlement records across all domains.
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

// ── Movie Analytics ──────────────────────────────────────────────────────────

/**
 * GET /api/owner/movies/analytics
 *
 * Movie-specific analytics (existing, preserved).
 *
 * Query params:
 *   from  — ISO date YYYY-MM-DD (default: 30 days ago)
 *   to    — ISO date YYYY-MM-DD (default: today)
 */
router.get('/movies/analytics', async (req: OrganizerRequest, res: Response, next: Function) => {
  try {
    const user = req.organizerUser;
    if (!user) {
      throw new AppError('Unauthorized', 401);
    }

    const from = (req.query.from as string) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = (req.query.to as string) ?? new Date().toISOString().slice(0, 10);

    const data = await ownerDashboardService.getMovieAnalytics(user.organizationId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// ── Event Analytics ──────────────────────────────────────────────────────────

/**
 * GET /api/owner/events/analytics
 *
 * Event-specific analytics: bookings, revenue, tickets sold, check-ins, per-event performance.
 * All results scoped to the organization.
 *
 * Query params:
 *   from  — ISO date YYYY-MM-DD (default: 30 days ago)
 *   to    — ISO date YYYY-MM-DD (default: today)
 */
router.get('/events/analytics', async (req: OrganizerRequest, res: Response, next: Function) => {
  try {
    const user = req.organizerUser;
    if (!user) {
      throw new AppError('Unauthorized', 401);
    }

    const from = (req.query.from as string) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = (req.query.to as string) ?? new Date().toISOString().slice(0, 10);

    const data = await ownerDashboardService.getEventAnalytics(user.organizationId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export default router;
