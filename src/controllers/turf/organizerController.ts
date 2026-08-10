/**
 * Turf organizer controller — organization-level turf management.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../middleware/errorHandler';
import { turfBookingRepository } from '../../repositories/turfBookingRepository';
import { turfVenueService } from '../../services/turfVenueService';
import { turfCouponService } from '../../services/turfCouponService';
import { turfSettlementService } from '../../services/turfSettlementService';

export async function listOrgBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const result = await turfBookingRepository.findByOrganization(orgId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function listOrgVenues(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const venues = await turfVenueService.listByOrganization(orgId);
    res.json({ success: true, data: venues });
  } catch (err) { next(err); }
}

export async function createOrgVenue(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const venue = await turfVenueService.create(orgId, req.body);
    res.status(201).json({ success: true, data: venue });
  } catch (err) { next(err); }
}

export async function listCoupons(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const coupons = await turfCouponService.listByOrganization(orgId);
    res.json({ success: true, data: coupons });
  } catch (err) { next(err); }
}

export async function createCoupon(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const coupon = await turfCouponService.create(orgId, req.body);
    res.status(201).json({ success: true, data: coupon });
  } catch (err) { next(err); }
}

export async function listSettlements(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = (req as any).organizerUser?.organization_id;
    const result = await turfSettlementService.listByOrganization(orgId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
