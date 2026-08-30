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
    const admin = (req as any).admin as { organizationId?: number | null; role?: string } | undefined;
    const queryOrgId = Number(req.query.organizationId || 0);

    // Super-admins (organizationId=null) can pass ?organizationId to filter
    // Org-scoped admins only see their own venues
    let orgId: number | undefined;
    if (admin?.organizationId == null) {
      orgId = queryOrgId || undefined;
    } else {
      orgId = admin.organizationId;
    }

    const result = await turfVenueRepository.findAll({ ...(orgId ? { organizationId: orgId } : {}) });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateVenueStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as any).admin as { organizationId?: number | null; role?: string } | undefined;
    const venueId = Number(req.params.venueId);
    const { status } = req.body;
    if (!['pending', 'approved', 'suspended'].includes(status)) {
      throw new AppError('Invalid status', 400);
    }

    // Verify org access: super-admin can update any venue; org-scoped admin only their orgs
    const venue = await turfVenueRepository.findById(venueId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (admin?.organizationId != null && venue.organization_id !== admin.organizationId) {
      throw new AppError('Forbidden — cannot modify venues from other organizations', 403);
    }

    const updated = await turfVenueRepository.update(venueId, { status });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
}

export async function listAllBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as any).admin as { organizationId?: number | null; role?: string } | undefined;
    const queryOrgId = Number(req.query.organizationId || 0);

    // Org-scoped admins (role='manager' OR organizationId set) MUST only see their own org.
    // Super-admins (organizationId=null) can specify any org via query string.
    let orgId: number;
    if (admin?.organizationId != null) {
      // If an org-scoped admin passes a query param, only allow their own org — reject others.
      if (queryOrgId !== 0 && queryOrgId !== admin.organizationId) {
        throw new AppError('Forbidden — cannot access other organization bookings', 403);
      }
      orgId = admin.organizationId;
    } else {
      // Super-admin: 0 means "all orgs"
      orgId = queryOrgId;
    }

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
    const admin = (req as any).admin as { organizationId?: number | null; role?: string } | undefined;
    const bookingId = Number(req.params.id);
    const booking = await turfBookingRepository.findDetail(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);

    // Verify org access: super-admin can see any booking; org-scoped admin only their orgs
    if (admin?.organizationId != null && booking.organization_id !== admin.organizationId) {
      throw new AppError('Forbidden — cannot access bookings from other organizations', 403);
    }

    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
}

export async function listVenueReviews(req: Request, res: Response, next: NextFunction) {
  try {
    const admin = (req as any).admin as { organizationId?: number | null; role?: string } | undefined;
    const venueId = Number(req.params.venueId);

    // Verify the venue belongs to the admin's org (or super-admin)
    const venue = await turfVenueRepository.findById(venueId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (admin?.organizationId != null && venue.organization_id !== admin.organizationId) {
      throw new AppError('Forbidden — cannot access reviews for other organization venues', 403);
    }

    const reviews = await turfReviewRepository.findByVenue(venueId);
    res.json({ success: true, data: reviews });
  } catch (err) { next(err); }
}
