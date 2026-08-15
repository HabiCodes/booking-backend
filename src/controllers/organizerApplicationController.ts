/**
 * Public organizer application endpoints.
 *
 * Anyone can submit an organizer application (no auth required).
 * Rate-limited in server.ts to prevent abuse.
 */

import { Request, Response, NextFunction } from 'express';
import { organizerApplicationService } from '../services/organizerApplicationService';
import { AppError } from '../middleware/errorHandler';

/**
 * POST /organizer/applications
 * Submit a new organizer application.
 */
export async function submitOrganizerApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body;
    const listingCategory = body.listing_category as string | undefined;

    // Validate required fields inline (fail-fast)
    if (!body.legal_name || !body.display_name || !body.email) {
      throw new AppError('legal_name, display_name, and email are required', 400);
    }

    // Validate listing_category
    const validCategories = ['turf', 'events', 'movies', 'concerts', 'other'];
    if (!listingCategory || !validCategories.includes(listingCategory)) {
      throw new AppError(`listing_category must be one of: ${validCategories.join(', ')}`, 400);
    }

    const result = await organizerApplicationService.submit(body);
    res.status(result.isNew ? 201 : 200).json({
      success: true,
      data: result.application,
      message: result.isNew
        ? 'Application submitted successfully'
        : 'Application updated and resubmitted',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /organizer/applications/status
 * Check the status of an application by email.
 * No auth required — uses email as lookup.
 */
export async function getApplicationStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = (req.query.email as string)?.trim();
    if (!email) {
      throw new AppError('email query parameter is required', 400);
    }

    const { organizerAppRepository } = await import('../repositories/organizerAppRepository');
    const app = await organizerAppRepository.findByEmail(email);
    if (!app) {
      throw new AppError('No application found for this email', 404);
    }

    // Return only public-safe fields — bank details, identity documents,
    // tax IDs, and payout info must never leak through an unauthenticated endpoint.
    const safe = {
      id: app.id,
      legal_name: app.legal_name,
      display_name: app.display_name,
      email: app.email,
      listing_category: app.listing_category,
      status: app.status,
      rejection_type: app.rejection_type,
      rejection_reason: app.rejection_reason,
      submitted_at: app.submitted_at,
      reviewed_at: app.reviewed_at,
    };

    res.json({ success: true, data: safe });
  } catch (err) {
    next(err);
  }
}
