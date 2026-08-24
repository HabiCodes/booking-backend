/**
 * Public organizer application routes.
 * No auth required — rate-limited to prevent abuse.
 */

import { Router } from 'express';
import {
  submitOrganizerApplication,
  getApplicationStatus,
} from '../controllers/organizerApplicationController';
import { createDistributedRateLimiter } from '../infrastructure/distributedRateLimiter';

const router = Router();

// Tighter rate limit on application submission: 5 per hour per IP (costly to spam)
const applicationSubmitLimiter = createDistributedRateLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many organizer application submissions. Please try again later.',
});

/**
 * POST /organizer/applications
 * Submit a new organizer application.
 * Body: { legal_name, display_name, email, listing_category, ...optional_fields }
 */
router.post('/', applicationSubmitLimiter, submitOrganizerApplication);

/**
 * GET /organizer/applications/status?email=<email>
 * Check the status of an existing application.
 */
router.get('/status', getApplicationStatus);

export { router as organizerApplicationRoutes };
