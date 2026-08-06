import { Request, Response, NextFunction } from 'express';
import { eventService } from '../services/eventService';
import type { EventListQuery } from '../types';

// ── Public endpoints ────────────────────────────────────────────────────────

export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const query: EventListQuery = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      city: req.query.city as string | undefined,
      fromDate: req.query.fromDate as string | undefined,
      toDate: req.query.toDate as string | undefined,
      sortBy: req.query.sortBy as EventListQuery['sortBy'],
      sortOrder: req.query.sortOrder as EventListQuery['sortOrder'],
      featured: req.query.featured === 'true' ? true : undefined,
    };

    const result = await eventService.listPublicEvents(query);

    // Public cache: 60s browser, 5min CDN/edge. Details will go stale faster
    // via the booking socket broadcast, so a short TTL is fine.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
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
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isFinite(eventId)) {
      return res.status(400).json({ success: false, message: 'Invalid event ID' });
    }
    const detail = await eventService.getPublicEventDetail(eventId);
    if (!detail) return res.status(404).json({ success: false, message: 'Event not found' });

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
    return res.json({
      success: true,
      data: {
        ...detail.event,
        stats: detail.stats,
        related: detail.related,
      },
    });
  } catch (err) {
    return next(err);
  }
}

export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const eventId = parseInt(req.params.id, 10);
    const stats = await eventService.getBookingStats(eventId);
    // Live capacity — don't cache aggressively
    res.setHeader('Cache-Control', 'public, max-age=5');
    res.json({ success: true, data: stats });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getFeaturedEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    const items = await eventService.listFeaturedEvents(limit);
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

/**
 * Public — list distinct categories used by published public events.
 * Used by the discovery page filter dropdown.
 */
export async function getCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    const items = await eventService.listPublicCategories();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

/**
 * Public — list distinct cities hosting published public events.
 */
export async function getCities(_req: Request, res: Response, next: NextFunction) {
  try {
    const items = await eventService.listPublicCities();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

// ── Admin endpoints (CRUD) ──────────────────────────────────────────────────

export async function adminListEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const query: EventListQuery = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      city: req.query.city as string | undefined,
      status: req.query.status as EventListQuery['status'],
      include_deleted: req.query.include_deleted === 'true',
    };
    const result = await eventService.listAllEvents(query);
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
    return next(err);
  }
}

export async function adminCreateEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = await eventService.createEvent(req.body);
    const event = await eventService.getEventById(id);
    res.status(201).json({ success: true, data: event });
  } catch (err) {
    return next(err);
  }
}

export async function adminUpdateEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const event = await eventService.updateEvent(id, req.body);
    res.json({ success: true, data: event });
  } catch (err) {
    return next(err);
  }
}

export async function adminDeleteEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await eventService.deleteEvent(id);
    res.json({ success: true, message: 'Event deleted' });
  } catch (err) {
    return next(err);
  }
}

export async function adminRestoreEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await eventService.restoreEvent(id);
    res.json({ success: true, message: 'Event restored' });
  } catch (err) {
    return next(err);
  }
}

export async function adminPublishEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await eventService.publishEvent(id);
    res.json({ success: true, data: result.event });
  } catch (err) {
    return next(err);
  }
}

export async function adminHideEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await eventService.hideEvent(id);
    res.json({ success: true, message: 'Event hidden' });
  } catch (err) {
    return next(err);
  }
}

export async function adminCancelEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await eventService.cancelEvent(id);
    res.json({ success: true, message: 'Event cancelled' });
  } catch (err) {
    return next(err);
  }
}

export async function adminSetFeatured(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const { is_featured } = req.body;
    await eventService.setFeatured(id, Boolean(is_featured));
    res.json({ success: true, message: 'Featured flag updated' });
  } catch (err) {
    return next(err);
  }
}