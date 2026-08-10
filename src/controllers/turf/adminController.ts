/**
 * Turf admin controller — platform admin oversight.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { turfVenueRepository } from '../../repositories/turfVenueRepository';
import { turfBookingRepository } from '../../repositories/turfBookingRepository';
import { turfReviewRepository } from '../../repositories/turfReviewRepository';
import { turfVenueService } from '../../services/turfVenueService';

export async function listAllVenues(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await turfVenueRepository.findAll({
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 25,
      
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateVenueStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'suspended'].includes(status)) {
      throw new AppError('Invalid status', 400);
    }
    const venue = await turfVenueService.update(Number(req.params.venueId), { status });
    res.json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function listAllBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = Number(req.query.organizationId || 0);
    const result = await turfBookingRepository.findByOrganization(orgId, {
      status: req.query.status as string,
      page: Number(req.query.page) || 1,
      pageSize: Number(req.query.pageSize) || 25,
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getBookingDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const booking = await turfBookingRepository.findDetail(Number(req.params.id));
    if (!booking) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
}

export async function listVenueReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const reviews = await turfReviewRepository.findByVenue(Number(req.params.venueId));
    res.json({ success: true, data: reviews });
  } catch (err) { next(err); }
}
