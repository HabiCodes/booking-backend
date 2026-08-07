/**
 * Event Lifecycle Admin Controller
 *
 * Endpoints:
 *   POST /api/admin/events/:id/submit-for-review
 *   POST /api/admin/events/:id/approve
 *   POST /api/admin/events/:id/reject
 *   POST /api/admin/events/:id/publish
 *   POST /api/admin/events/:id/unpublish
 *   POST /api/admin/events/:id/hide
 *   POST /api/admin/events/:id/show
 *   POST /api/admin/events/:id/archive
 *   POST /api/admin/events/:id/restore
 *   GET  /api/admin/events/:id/history
 *   GET  /api/admin/events/pending-review
 */

import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { eventLifecycleService } from '../services/eventLifecycleService';
import { eventRepository } from '../repositories/eventRepository';

function eventIdParam(req: Request): number {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    throw { statusCode: 400, message: 'Invalid event ID' } as Error & { statusCode?: number };
  }
  return id;
}

function actor(req: AdminRequest) {
  return {
    adminId: req.admin?.id ?? null,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
  };
}

// ── Transition handlers ───────────────────────────────────────────────────────
// Each handler delegates to the service, which validates the state machine,
// applies the transition + side-effects in a single transaction, and appends
// the history row.

export async function submitForReview(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string | null };
    const { event } = await eventLifecycleService.submitForReview(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function approveEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const { event } = await eventLifecycleService.approveEvent(eventId, actor(req));
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function rejectEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string };
    if (!body.reason?.trim()) {
      throw { statusCode: 400, message: 'rejection reason is required' } as Error & { statusCode?: number };
    }
    const { event } = await eventLifecycleService.rejectEvent(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function publishEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const { event } = await eventLifecycleService.publishEvent(eventId, actor(req));
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function unpublishEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const { event } = await eventLifecycleService.unpublishEvent(eventId, actor(req));
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function hideEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string | null };
    const { event } = await eventLifecycleService.hideEvent(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function showEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const { event } = await eventLifecycleService.showEvent(eventId, actor(req));
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function archiveEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string | null };
    const { event } = await eventLifecycleService.archiveEvent(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function restoreEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string | null };
    const { event } = await eventLifecycleService.restoreEvent(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function cancelEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const body = (req.body ?? {}) as { reason?: string | null };
    const { event } = await eventLifecycleService.cancelEvent(eventId, actor(req), body.reason);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

// ── History ───────────────────────────────────────────────────────────────────

export async function getEventHistory(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const eventId = eventIdParam(req);
    const history = await eventLifecycleService.getHistory(eventId);
    res.json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
}

// ── Review queue ──────────────────────────────────────────────────────────────

export async function listPendingReview(
  req: AdminRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
    const page = req.query.page ? Number(req.query.page) : 1;
    const result = await eventRepository.listPendingReview(pageSize, page);
    res.json({
      success: true,
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    next(err);
  }
}
