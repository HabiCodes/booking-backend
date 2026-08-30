/**
 * Movie Manager Routes — organization-scoped movie management.
 *
 * Mounted at /api/organizer/v1/movies
 * Requires: organizerAuthMiddleware + appropriate organizer permissions.
 *
 * All routes are scoped to the caller's organization_id.
 * Owners get full access. Managers get CRUD but cannot publish movies.
 */

import { Router } from 'express';
import {
  listOrgMovies, getOrgMovie, createOrgMovie, updateOrgMovie, deleteOrgMovie,
  uploadMoviePoster, uploadMovieBackdrop,
  listOrgCinemas, getOrgCinema, createOrgCinema, updateOrgCinema, deleteOrgCinema,
  listOrgScreens, getOrgScreen, createOrgScreen, updateOrgScreen, deleteOrgScreen,
  listOrgShowtimes, getOrgShowtime, createOrgShowtime, updateOrgShowtime, deleteOrgShowtime,
  listOrgPriceCaps, getOrgPriceCap, createOrgPriceCap, updateOrgPriceCap, deleteOrgPriceCap,
} from '../controllers/movieManagerController';
import {
  createOfflineBooking, listOfflineBookings, getOfflineBooking,
} from '../controllers/movieOfflineBookingController';
import { requireOrganizerPermission } from '../middleware/organizerPermissions';
import { requireOwner, requireAnyPermission } from '../middleware/organizerPermissionMiddleware';
import { organizerAuthMiddleware, type OrganizerRequest } from '../middleware/organizerAuth';
import { jsonUploadMiddleware } from '../middleware/upload';
import { layoutVersionService } from '../services/layoutVersionService';
import { AppError } from '../middleware/errorHandler';

export const organizerMovieRouter = Router();

organizerMovieRouter.use(organizerAuthMiddleware);

// ── Movies ────────────────────────────────────────────────────────────────────

organizerMovieRouter.get('/movies', requireOrganizerPermission('organizer:movies:read'), listOrgMovies);
organizerMovieRouter.get('/movies/:id', requireOrganizerPermission('organizer:movies:read'), getOrgMovie);
// Only owners can publish; managers can create drafts
organizerMovieRouter.post('/movies', requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'), createOrgMovie);
organizerMovieRouter.put('/movies/:id', requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'), updateOrgMovie);
organizerMovieRouter.patch('/movies/:id', requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'), updateOrgMovie);
organizerMovieRouter.delete('/movies/:id', requireOrganizerPermission('organizer:movies:delete'), deleteOrgMovie);

// ── Movie Poster/Backdrop Upload ───────────────────────────────────────────────

organizerMovieRouter.post(
  '/movies/:id/upload-poster',
  jsonUploadMiddleware,
  requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'),
  uploadMoviePoster
);

organizerMovieRouter.post(
  '/movies/:id/upload-backdrop',
  jsonUploadMiddleware,
  requireAnyPermission('organizer:movies:write', 'organizer:movies:publish'),
  uploadMovieBackdrop
);

// ── Cinemas ───────────────────────────────────────────────────────────────────

organizerMovieRouter.get('/cinemas', requireOrganizerPermission('organizer:cinemas:read'), listOrgCinemas);
organizerMovieRouter.get('/cinemas/:id', requireOrganizerPermission('organizer:cinemas:read'), getOrgCinema);
organizerMovieRouter.post('/cinemas', requireOrganizerPermission('organizer:cinemas:write'), createOrgCinema);
organizerMovieRouter.put('/cinemas/:id', requireAnyPermission('organizer:cinemas:write', 'organizer:cinemas:delete'), updateOrgCinema);
organizerMovieRouter.patch('/cinemas/:id', requireAnyPermission('organizer:cinemas:write', 'organizer:cinemas:delete'), updateOrgCinema);
organizerMovieRouter.delete('/cinemas/:id', requireOwner, deleteOrgCinema);

// ── Screens ───────────────────────────────────────────────────────────────────

organizerMovieRouter.get('/screens', requireOrganizerPermission('organizer:screens:read'), listOrgScreens);
organizerMovieRouter.get('/screens/:id', requireOrganizerPermission('organizer:screens:read'), getOrgScreen);
organizerMovieRouter.post('/cinemas/:cinemaId/screens', requireOrganizerPermission('organizer:screens:write'), createOrgScreen);
organizerMovieRouter.put('/screens/:id', requireAnyPermission('organizer:screens:write', 'organizer:screens:delete'), updateOrgScreen);
organizerMovieRouter.patch('/screens/:id', requireAnyPermission('organizer:screens:write', 'organizer:screens:delete'), updateOrgScreen);
organizerMovieRouter.delete('/screens/:id', requireOwner, deleteOrgScreen);

// ── Layout Versions (screen seat history) ─────────────────────────────────────

// GET /screens/:screenId/layout-versions
organizerMovieRouter.get('/screens/:screenId/layout-versions',
  requireOrganizerPermission('organizer:screens:read'),
  async (req: OrganizerRequest, res, next): Promise<void> => {
    try {
      const screenId = Number(req.params.screenId);
      const versions = await layoutVersionService.listForScreen(screenId);
      res.json({ success: true, data: versions });
    } catch (err) { next(err); }
  }
);

// GET /screens/:screenId/layout-versions/current
organizerMovieRouter.get('/screens/:screenId/layout-versions/current',
  requireOrganizerPermission('organizer:screens:read'),
  async (req: OrganizerRequest, res, next): Promise<void> => {
    try {
      const screenId = Number(req.params.screenId);
      const version = await layoutVersionService.getCurrent(screenId);
      if (!version) {
        res.status(404).json({ success: false, message: 'No layout version found' });
        return;
      }
      res.json({ success: true, data: version });
    } catch (err) { next(err); }
  }
);

// POST /screens/:screenId/layout-versions — only owners can create new layout versions
organizerMovieRouter.post('/screens/:screenId/layout-versions',
  requireOwner,
  async (req: OrganizerRequest, res, next): Promise<void> => {
    try {
      const screenId = Number(req.params.screenId);
      const { name, description } = req.body as { name?: string; description?: string };
      const version = await layoutVersionService.createNewVersionFromScreen(
        screenId,
        name || 'Updated Layout',
        description
      );
      res.status(201).json({ success: true, data: version });
    } catch (err) { next(err); }
  }
);

// PATCH /layout-versions/:id/set-current — only owners
organizerMovieRouter.patch('/layout-versions/:id/set-current',
  requireOwner,
  async (req: OrganizerRequest, res, next): Promise<void> => {
    try {
      const versionId = Number(req.params.id);
      // First, get the version to find its screen
      const version = await layoutVersionService.getById(versionId);
      if (!version) {
        res.status(404).json({ success: false, message: 'Layout version not found' });
        return;
      }
      const updated = await layoutVersionService.setCurrentVersion(version.screenId, versionId);
      if (!updated) {
        res.status(500).json({ success: false, message: 'Failed to set current version' });
        return;
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  }
);

// GET /layout-versions/:id/seats
organizerMovieRouter.get('/layout-versions/:id/seats',
  requireOrganizerPermission('organizer:screens:read'),
  async (req: OrganizerRequest, res, next): Promise<void> => {
    try {
      const versionId = Number(req.params.id);
      const seats = await layoutVersionService.getSeats(versionId);
      res.json({ success: true, data: seats });
    } catch (err) { next(err); }
  }
);

// ── Showtimes ─────────────────────────────────────────────────────────────────

organizerMovieRouter.get('/showtimes', requireOrganizerPermission('organizer:showtimes:read'), listOrgShowtimes);
organizerMovieRouter.get('/showtimes/:id', requireOrganizerPermission('organizer:showtimes:read'), getOrgShowtime);
organizerMovieRouter.post('/showtimes', requireOrganizerPermission('organizer:showtimes:write'), createOrgShowtime);
organizerMovieRouter.put('/showtimes/:id', requireOrganizerPermission('organizer:showtimes:write'), updateOrgShowtime);
organizerMovieRouter.patch('/showtimes/:id', requireOrganizerPermission('organizer:showtimes:write'), updateOrgShowtime);
organizerMovieRouter.delete('/showtimes/:id', requireOwner, deleteOrgShowtime);

// ── Price Caps ────────────────────────────────────────────────────────────────

organizerMovieRouter.get('/price-caps', requireOrganizerPermission('organizer:price_caps:read'), listOrgPriceCaps);
organizerMovieRouter.get('/price-caps/:id', requireOrganizerPermission('organizer:price_caps:read'), getOrgPriceCap);
// Only owners can create/update/delete price caps
organizerMovieRouter.post('/price-caps', requireOwner, createOrgPriceCap);
organizerMovieRouter.put('/price-caps/:id', requireOwner, updateOrgPriceCap);
organizerMovieRouter.patch('/price-caps/:id', requireOwner, updateOrgPriceCap);
organizerMovieRouter.delete('/price-caps/:id', requireOwner, deleteOrgPriceCap);

// ── Offline / Counter Bookings ──────────────────────────────────────────────

// Only owners and managers with write permission can create offline bookings
organizerMovieRouter.post('/offline-bookings', requireAnyPermission('organizer:bookings:write', 'organizer:bookings:delete'), createOfflineBooking);
organizerMovieRouter.get('/offline-bookings', requireOrganizerPermission('organizer:bookings:read'), listOfflineBookings);
organizerMovieRouter.get('/offline-bookings/:id', requireOrganizerPermission('organizer:bookings:read'), getOfflineBooking);
