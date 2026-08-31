import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { eventService } from '../services/eventService';
import { eventRepository } from '../repositories/eventRepository';
import type { AdminRequest } from '../middleware/adminAuth';
import type { EventCreateInput, EventListQuery } from '../types';

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

function enforceEventOrgAccess(req: AdminRequest, event: { organization_id: number | null }): void {
  const adminOrgId = req.admin?.organizationId ?? null;
  if (adminOrgId === null) return; // super_admin — global access
  if (event.organization_id !== adminOrgId) {
    throw new AppError('Not authorized to access this event', 403);
  }
}

export async function adminListEvents(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const adminOrgId = req.admin?.organizationId ?? null;
    const query: EventListQuery = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      city: req.query.city as string | undefined,
      status: req.query.status as EventListQuery['status'],
      include_deleted: req.query.include_deleted === 'true',
    };
    const result = await eventService.listAllEvents(query, adminOrgId);
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

export async function adminCreateEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const adminOrgId = req.admin?.organizationId ?? null;
    const payload = { ...(req.body as Record<string, unknown>) };

    // Org-scoped admin: force event into their organization, ignore client-supplied org_id
    if (adminOrgId !== null) {
      payload.organization_id = adminOrgId;
    }
    // Super_admin (adminOrgId=null): can create events without org or with explicit org_id

    const id = await eventService.createEvent(payload as unknown as EventCreateInput);
    const event = await eventService.getEventById(id);
    res.status(201).json({ success: true, data: event });
  } catch (err) {
    return next(err);
  }
}

export async function adminUpdateEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);

    // Mass-assignment protection: strip fields that must be changed only through
    // dedicated lifecycle endpoints (publish/hide/show/cancel/archive/restore/feature).
    const allowedFields = new Set([
      'title', 'subtitle', 'description', 'category', 'venue',
      'address', 'city', 'state', 'country',
      'latitude', 'longitude',
      'event_date', 'start_time', 'end_time',
      'start_at', 'end_at',
      'banner_url', 'thumbnail_url', 'logo_url',
      'gallery', 'organizer',
      'capacity', 'price', 'currency',
      'cancel_window_hours',
      'is_active',
    ]);
    const whitelisted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (allowedFields.has(key)) {
        whitelisted[key] = value;
      }
    }

    // Org-scoped admin: prevent changing organization_id
    const adminOrgId = req.admin?.organizationId ?? null;
    if (adminOrgId !== null && whitelisted.organization_id !== undefined) {
      delete whitelisted.organization_id;
    }

    const event = await eventService.updateEvent(id, whitelisted);
    res.json({ success: true, data: event });
  } catch (err) {
    return next(err);
  }
}

export async function adminDeleteEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    await eventService.deleteEvent(id);
    res.json({ success: true, message: 'Event deleted' });
  } catch (err) {
    return next(err);
  }
}

export async function adminRestoreEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    await eventService.restoreEvent(id);
    res.json({ success: true, message: 'Event restored' });
  } catch (err) {
    return next(err);
  }
}

export async function adminPublishEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    const result = await eventService.publishEvent(id);
    res.json({ success: true, data: result.event });
  } catch (err) {
    return next(err);
  }
}

export async function adminHideEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    await eventService.hideEvent(id);
    res.json({ success: true, message: 'Event hidden' });
  } catch (err) {
    return next(err);
  }
}

export async function adminCancelEvent(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    await eventService.cancelEvent(id);
    res.json({ success: true, message: 'Event cancelled' });
  } catch (err) {
    return next(err);
  }
}

export async function adminSetFeatured(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    enforceEventOrgAccess(req, existing);
    const { is_featured } = req.body;
    await eventService.setFeatured(id, Boolean(is_featured));
    res.json({ success: true, message: 'Featured flag updated' });
  } catch (err) {
    return next(err);
  }
}