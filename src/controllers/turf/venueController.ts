/**
 * Turf venue controller — organizer CRUD for turf venues and resources.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { turfVenueService } from '../../services/turfVenueService';
import { turfAvailabilityService } from '../../services/turfAvailabilityService';
import { turfVenueRepository } from '../../repositories/turfVenueRepository';

export async function listVenues(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venues = await turfVenueService.listByOrganization(orgId);
    res.json({ success: true, data: venues });
  } catch (err) { next(err); }
}

export async function createVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venue = await turfVenueService.create(orgId, req.body);
    res.status(201).json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function getVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venue = await turfVenueService.getById(Number(req.params.venueId), orgId);
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function updateVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venue = await turfVenueService.update(Number(req.params.venueId), orgId, req.body);
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function deleteVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    await turfVenueService.softDelete(Number(req.params.venueId), orgId);
    res.json({ success: true, message: 'Venue deleted' });
  } catch (err) { next(err); }
}

export async function createResource(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const resource = await turfVenueService.createResource(Number(req.params.venueId), orgId, req.body);
    res.status(201).json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function listResources(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const result = await turfVenueService.listResources(Number(req.params.venueId), orgId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getResource(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const resource = await turfVenueService.getResource(Number(req.params.resourceId), orgId);
    res.json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function updateResource(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const resource = await turfVenueService.updateResource(Number(req.params.resourceId), orgId, req.body);
    res.json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function listSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venueId = Number(req.params.venueId);
    const resourceId = Number(req.params.resourceId);
    const date = String(req.query.date || '').trim();

    if (orgId) {
      const venue = await turfVenueRepository.findById(venueId);
      if (!venue) {
        res.status(404).json({ success: false, error: 'Venue not found' });
        return;
      }
      if (venue.organization_id !== orgId) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    const slots = await turfAvailabilityService.listSlots(resourceId, date, orgId);
    res.json({ success: true, data: slots });
  } catch (err) { next(err); }
}

export async function generateSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organizationId;
    const venueId = Number(req.params.venueId);
    const resourceId = Number(req.params.resourceId);
    const { date, startTime, endTime, slotDurationMinutes, price } = req.body;

    if (orgId) {
      const venue = await turfVenueRepository.findById(venueId);
      if (!venue) {
        res.status(404).json({ success: false, error: 'Venue not found' });
        return;
      }
      if (venue.organization_id !== orgId) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
      }
    }

    const result = await turfAvailabilityService.generateSlots(
      resourceId, date, startTime, endTime, slotDurationMinutes, price, orgId
    );
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
