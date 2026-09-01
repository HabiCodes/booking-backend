/**
 * requireVenueAccess — enforces assigned_venue_ids boundary for turf managers.
 *
 * Semantics:
 * - assignedVenueIds = [] → user has access to ALL venues (owner or unrestricted manager)
 * - assignedVenueIds = [5, 7, 9] → user can ONLY access those specific venues
 *
 * Usage:
 *   router.get('/venues/:venueId/x', requireVenueAccessMiddleware, handler)
 *   // OR for derived venue lookups in handlers:
 *   await enforceVenueAccess(req.organizerUser!.assignedVenueIds, venueId);
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import type { OrganizerRequest } from './organizerAuth';

/**
 * Middleware factory — use when venueId is in URL params.
 */
export function requireVenueAccess(paramName = 'venueId') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const manager = (req as OrganizerRequest).organizerUser;
    if (!manager) {
      return next(new AppError('Unauthorized', 401));
    }

    const venueId = Number(req.params[paramName]);
    if (isNaN(venueId) || venueId <= 0) {
      return next(new AppError('Invalid venue ID', 400));
    }

    enforceVenueAccess(manager.assignedVenueIds, venueId);
    next();
  };
}

/**
 * Direct enforcement — use in handlers where venueId is resolved from
 * an availability unit, booking, resource, etc. (not from URL params).
 */
export function enforceVenueAccess(assignedVenueIds: number[] | undefined, venueId: number): void {
  const ids = assignedVenueIds || [];
  if (ids.length > 0 && !ids.includes(venueId)) {
    throw new AppError('You do not have access to this venue', 403);
  }
}

/**
 * Build a SQL filter clause for listing queries that respects assigned_venue_ids.
 * Returns { clause, params } — clause is an empty string if no filter needed,
 * or a "AND v.id = ANY($N)" fragment when the manager is restricted.
 *
 * Usage:
 *   const { clause, params } = buildVenueFilter(manager.assignedVenueIds, baseParams);
 *   const sql = `SELECT ... FROM turf_venues v WHERE ... ${clause}`;
 */
export function buildVenueFilter(
  assignedVenueIds: number[],
  baseParams: unknown[],
): { clause: string; params: unknown[] } {
  if (assignedVenueIds.length === 0) {
    return { clause: '', params: baseParams };
  }
  const idx = baseParams.length + 1;
  return {
    clause: `AND v.id = ANY($${idx})`,
    params: [...baseParams, assignedVenueIds],
  };
}
