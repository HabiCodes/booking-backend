/**
 * Event Zone Controller — HTTP layer for zone CRUD.
 *
 * Routes:
 *   GET    /api/events/:id/zones                   — list zones (public)
 *   GET    /api/events/:id/zones/:zoneId          — get zone (public)
 *   POST   /api/admin/events/:id/zones            — create zone (admin)
 *   PUT    /api/admin/events/zones/:zoneId        — update zone (admin)
 *   DELETE /api/admin/events/zones/:zoneId        — soft delete zone (admin)
 *   GET    /api/admin/events/:id/zones/availability — get availability (admin)
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { eventZoneService } from '../services/eventZoneService';
import { eventRepository } from '../repositories/eventRepository';
import type { AdminRequest } from '../middleware/adminAuth';
import type { EventZoneCreateInput, EventZoneUpdateInput } from '../types';

// ── Public reads ──────────────────────────────────────────────────────────────

export async function listZones(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!eventId || isNaN(eventId)) throw new AppError('Invalid event ID', 400);

    const zones = await eventZoneService.listZones(eventId);
    res.json({ zones });
  } catch (err) {
    next(err);
  }
}

export async function getZone(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const zoneId = parseInt(req.params.zoneId, 10);
    if (!zoneId || isNaN(zoneId)) throw new AppError('Invalid zone ID', 400);

    const zone = await eventZoneService.getZone(zoneId);
    res.json({ zone });
  } catch (err) {
    next(err);
  }
}

// ── Admin writes ──────────────────────────────────────────────────────────────

export async function adminCreateZone(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!eventId || isNaN(eventId)) throw new AppError('Invalid event ID', 400);

    // Verify org ownership for the event
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    const adminOrgId = req.admin?.organizationId ?? null;
    if (adminOrgId !== null && event.organization_id !== adminOrgId) {
      throw new AppError('Not authorized to add zones to this event', 403);
    }

    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new AppError('Zone name is required', 400);
    }
    if (typeof body.total_capacity !== 'number' || body.total_capacity < 0) {
      throw new AppError('total_capacity must be a non-negative number', 400);
    }
    if (typeof body.price !== 'number' || body.price < 0) {
      throw new AppError('price must be a non-negative number', 400);
    }

    const input: EventZoneCreateInput = {
      name: body.name.trim(),
      description: body.description ?? null,
      color: body.color ?? null,
      total_capacity: body.total_capacity,
      price: body.price,
      currency: body.currency,
      sort_order: body.sort_order,
    };

    const zone = await eventZoneService.createZone(eventId, input);
    res.status(201).json({ zone });
  } catch (err) {
    next(err);
  }
}

export async function adminUpdateZone(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const zoneId = parseInt(req.params.zoneId, 10);
    if (!zoneId || isNaN(zoneId)) throw new AppError('Invalid zone ID', 400);

    const fetchedZone = await eventZoneService.getZone(zoneId);
    const evt = await eventRepository.getEventById(fetchedZone.event_id);
    if (!evt) throw new AppError('Event not found for this zone', 404);
    const adminOrgId = req.admin?.organizationId ?? null;
    if (adminOrgId !== null && evt.organization_id !== adminOrgId) {
      throw new AppError('Not authorized to modify this zone', 403);
    }

    const body = req.body || {};
    const input: EventZoneUpdateInput = {};
    if (body.name !== undefined) input.name = body.name;
    if (body.description !== undefined) input.description = body.description;
    if (body.color !== undefined) input.color = body.color;
    if (body.total_capacity !== undefined) input.total_capacity = body.total_capacity;
    if (body.price !== undefined) input.price = body.price;
    if (body.is_active !== undefined) input.is_active = body.is_active;
    if (body.sort_order !== undefined) input.sort_order = body.sort_order;

    const updatedZone = await eventZoneService.updateZone(zoneId, input);
    res.json({ zone: updatedZone });
  } catch (err) {
    next(err);
  }
}

export async function adminDeleteZone(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const zoneId = parseInt(req.params.zoneId, 10);
    if (!zoneId || isNaN(zoneId)) throw new AppError('Invalid zone ID', 400);

    // Verify the admin has access to the zone's event's organization
    const zone = await eventZoneService.getZone(zoneId);
    const event = await eventRepository.getEventById(zone.event_id);
    if (!event) throw new AppError('Event not found for this zone', 404);
    const adminOrgId = req.admin?.organizationId ?? null;
    if (adminOrgId !== null && event.organization_id !== adminOrgId) {
      throw new AppError('Not authorized to delete this zone', 403);
    }

    await eventZoneService.deleteZone(zoneId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

export async function adminGetAvailability(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!eventId || isNaN(eventId)) throw new AppError('Invalid event ID', 400);

    // Verify org ownership for the event
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    const adminOrgId = req.admin?.organizationId ?? null;
    if (adminOrgId !== null && event.organization_id !== adminOrgId) {
      throw new AppError('Not authorized to view this event\'s zones', 403);
    }

    const availability = await eventZoneService.getZoneAvailability(eventId);
    res.json({ zones: availability });
  } catch (err) {
    next(err);
  }
}
