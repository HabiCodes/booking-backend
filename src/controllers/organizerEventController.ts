import { Request, Response, NextFunction } from 'express';
import { organizerEventService } from '../services/organizerEventService';
import type { EventStatus } from '../types';
import { AppError } from '../middleware/errorHandler';
import { organizerAuthMiddleware, OrganizerRequest } from '../middleware/organizerAuth';

export async function listEvents(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.organizerUser!.id;
    const organizationId = req.organizerUser!.organizationId;
    const { page = 1, pageSize = 20, search, status } = req.query as Record<string, string>;
    const data = await organizerEventService.listForOrganization(organizationId, {
      page: Number(page),
      pageSize: Number(pageSize),
      search: search || undefined,
      status: (status || undefined) as EventStatus | undefined,
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function getEvent(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const event = await organizerEventService.getById(Number(req.params.id), req.organizerUser!.id);
    res.json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

export async function createEvent(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const data = await organizerEventService.create(
      { ...req.body, organization_id: req.organizerUser!.organizationId },
      req.organizerUser!.id
    );
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function updateEvent(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const data = await organizerEventService.update(Number(req.params.id), req.body, req.organizerUser!.id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function deleteEvent(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    await organizerEventService.delete(Number(req.params.id), req.organizerUser!.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getEventTicketTiers(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const tiers = await organizerEventService.getTicketTiers(Number(req.params.id), req.organizerUser!.id);
    res.json({ success: true, data: tiers });
  } catch (err) {
    next(err);
  }
}

export async function getEventSeats(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const seats = await organizerEventService.getSeats(Number(req.params.id), req.organizerUser!.id);
    res.json({ success: true, data: seats });
  } catch (err) {
    next(err);
  }
}

export async function createEventSeats(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const result = await organizerEventService.createSeats(Number(req.params.id), req.body, req.organizerUser!.id);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
