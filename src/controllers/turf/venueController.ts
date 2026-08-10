/**
 * Turf venue controller — organizer CRUD for turf venues and resources.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { turfVenueService } from '../../services/turfVenueService';
import { turfAvailabilityService } from '../../services/turfAvailabilityService';

export async function listVenues(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const venues = await turfVenueService.listByOrganization(orgId);
    res.json({ success: true, data: venues });
  } catch (err) { next(err); }
}

export async function createVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const venue = await turfVenueService.create(orgId, req.body);
    res.status(201).json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function getVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await turfVenueService.getById(Number(req.params.venueId));
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function updateVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const venue = await turfVenueService.update(Number(req.params.venueId), req.body);
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function deleteVenue(req: Request, res: Response, next: NextFunction) {
  try {
    await turfVenueService.softDelete(Number(req.params.venueId));
    res.json({ success: true, message: 'Venue deleted' });
  } catch (err) { next(err); }
}

export async function createResource(req: Request, res: Response, next: NextFunction) {
  try {
    const resource = await turfVenueService.createResource(Number(req.params.venueId), req.body);
    res.status(201).json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function listResources(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await turfVenueService.listResources(Number(req.params.venueId), req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getResource(req: Request, res: Response, next: NextFunction) {
  try {
    const resource = await turfVenueService.getResource(Number(req.params.resourceId));
    res.json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function updateResource(req: Request, res: Response, next: NextFunction) {
  try {
    const resource = await turfVenueService.updateResource(Number(req.params.resourceId), req.body);
    res.json({ success: true, data: resource });
  } catch (err) { next(err); }
}

export async function listSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const resourceId = Number(req.params.resourceId);
    const date = String(req.query.date || '').trim();
    if (!date) throw new AppError('date (YYYY-MM-DD) required', 400);
    const slots = await turfAvailabilityService.listSlots(resourceId, date);
    res.json({ success: true, data: { slots, date } });
  } catch (err) { next(err); }
}

export async function generateSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const resourceId = Number(req.params.resourceId);
    const { date, startTime, endTime, slotDurationMinutes, price } = req.body;
    const result = await turfAvailabilityService.generateSlots(resourceId, date, startTime, endTime, slotDurationMinutes, price);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
