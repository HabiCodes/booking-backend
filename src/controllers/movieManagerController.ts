/**
 * Movie Manager Controller — organization-scoped movie management.
 *
 * All endpoints require organizerAuthMiddleware + appropriate permissions.
 * Owners have full access. Managers can CRUD but cannot publish movies.
 */

import { Request, Response, NextFunction } from 'express';
import { movieManagerService } from '../services/movieManagerService';
import { requireOrganizerPermission, organizerHasPermission } from '../middleware/organizerPermissions';
import { organizerAuthMiddleware, OrganizerRequest } from '../middleware/organizerAuth';
import { mediaService } from '../services/mediaService';
import { mediaRepository } from '../repositories/mediaRepository';
import { AppError } from '../middleware/errorHandler';
import type { UploadRequest } from '../middleware/upload';
import { config } from '../config';

// ── Movies (organizer) ────────────────────────────────────────────────────────

export async function listOrgMovies(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const search = req.query.search as string | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const movies = await movieManagerService.listMovies(orgId, search);
    return res.json({ success: true, data: movies, pagination: { total: movies.length, page, pageSize, totalPages: 1 } });
  } catch (err) { return next(err); }
}

export async function getOrgMovie(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const movieId = Number(req.params.id);
    const movie = await movieManagerService.getMovie(orgId, movieId);
    if (!movie) return res.status(404).json({ success: false, message: 'Movie not found or not in your cinemas' });
    return res.json({ success: true, data: movie });
  } catch (err) { return next(err); }
}

export async function createOrgMovie(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const input = req.body;
    // Only owners can publish — managers get draft status
    if (!organizerHasPermission(req, 'organizer:movies:publish')) {
      input.status = input.status || 'draft';
    }
    const movie = await movieManagerService.createMovie(orgId, input);
    return res.status(201).json({ success: true, data: movie });
  } catch (err) { return next(err); }
}

export async function updateOrgMovie(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const movieId = Number(req.params.id);
    const movie = await movieManagerService.updateMovie(orgId, movieId, req.body);
    if (!movie) return res.status(404).json({ success: false, message: 'Movie not found or not in your cinemas' });
    return res.json({ success: true, data: movie });
  } catch (err) { return next(err); }
}

export async function deleteOrgMovie(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const movieId = Number(req.params.id);
    const result = await movieManagerService.deleteMovie(orgId, movieId);
    if (!result) return res.status(404).json({ success: false, message: 'Movie not found or has active showtimes' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
}

// ── Movie Poster Upload ────────────────────────────────────────────────────────

/**
 * Upload a poster image for a movie. Stores the file through the S3/media abstraction
 * and updates the movie's poster_url with the media proxy URL.
 */
export async function uploadMoviePoster(req: OrganizerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.organizerUser!.organizationId;
    const movieId = Number(req.params.id);
    const upReq = req as UploadRequest;
    const file = upReq.upload;

    if (!file) throw new AppError('No file uploaded', 400);

    // Verify the movie belongs to this org
    const existing = await movieManagerService.getMovie(orgId, movieId);
    if (!existing) {
      res.status(404).json({ success: false, message: 'Movie not found or not in your cinemas' });
      return;
    }

    // If there's an existing poster stored through the media system, clean it up
    if (existing.posterUrl && existing.posterUrl.startsWith('/api/media/proxy/')) {
      const oldKey = decodeURIComponent(existing.posterUrl.replace('/api/media/proxy/', ''));
      const oldMedia = await mediaRepository.findByStorageKey(oldKey);
      if (oldMedia) {
        await mediaService.deleteMedia(oldMedia.id);
      }
    }

    // Upload new poster through media system
    const media = await mediaService.processUpload(file.buffer, {
      mimeType: file.mimeType,
      fileName: file.originalName || 'movie_poster',
      subdir: 'movies',
      uploadedBy: req.organizerUser!.id,
      uploadedByRole: 'organizer',
      organizationId: orgId,
      isPublic: true,
    });

    // Update movie with the new poster URL
    const updated = await movieManagerService.updateMovie(orgId, movieId, {
      posterUrl: media.public_url,
    });

    res.status(200).json({ success: true, data: { media, movie: updated } });
  } catch (err) {
    next(err);
  }
}

/**
 * Upload a backdrop image for a movie.
 */
export async function uploadMovieBackdrop(req: OrganizerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const orgId = req.organizerUser!.organizationId;
    const movieId = Number(req.params.id);
    const upReq = req as UploadRequest;
    const file = upReq.upload;

    if (!file) throw new AppError('No file uploaded', 400);

    const existing = await movieManagerService.getMovie(orgId, movieId);
    if (!existing) {
      res.status(404).json({ success: false, message: 'Movie not found or not in your cinemas' });
      return;
    }

    // Clean up old backdrop if stored through media system
    if (existing.backdropUrl && existing.backdropUrl.startsWith('/api/media/proxy/')) {
      const oldKey = decodeURIComponent(existing.backdropUrl.replace('/api/media/proxy/', ''));
      const oldMedia = await mediaRepository.findByStorageKey(oldKey);
      if (oldMedia) {
        await mediaService.deleteMedia(oldMedia.id);
      }
    }

    const media = await mediaService.processUpload(file.buffer, {
      mimeType: file.mimeType,
      fileName: file.originalName || 'movie_backdrop',
      subdir: 'movies',
      uploadedBy: req.organizerUser!.id,
      uploadedByRole: 'organizer',
      organizationId: orgId,
      isPublic: true,
    });

    const updated = await movieManagerService.updateMovie(orgId, movieId, {
      backdropUrl: media.public_url,
    });

    res.status(200).json({ success: true, data: { media, movie: updated } });
  } catch (err) {
    next(err);
  }
}

// ── Cinemas (organizer) ───────────────────────────────────────────────────────

export async function listOrgCinemas(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemas = await movieManagerService.listCinemas(orgId);
    return res.json({ success: true, data: cinemas });
  } catch (err) { return next(err); }
}

export async function getOrgCinema(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemaId = Number(req.params.id);
    const cinema = await movieManagerService.getCinema(orgId, cinemaId);
    if (!cinema) return res.status(404).json({ success: false, message: 'Cinema not found' });
    return res.json({ success: true, data: cinema });
  } catch (err) { return next(err); }
}

export async function createOrgCinema(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinema = await movieManagerService.createCinema(orgId, req.body);
    return res.status(201).json({ success: true, data: cinema });
  } catch (err) { return next(err); }
}

export async function updateOrgCinema(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemaId = Number(req.params.id);
    const cinema = await movieManagerService.updateCinema(orgId, cinemaId, req.body);
    if (!cinema) return res.status(404).json({ success: false, message: 'Cinema not found' });
    return res.json({ success: true, data: cinema });
  } catch (err) { return next(err); }
}

export async function deleteOrgCinema(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemaId = Number(req.params.id);
    const result = await movieManagerService.deleteCinema(orgId, cinemaId);
    if (!result) return res.status(404).json({ success: false, message: 'Cinema not found' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
}

// ── Screens (organizer) ───────────────────────────────────────────────────────

export async function listOrgScreens(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemaId = req.query.cinemaId ? Number(req.query.cinemaId) : undefined;
    const result = await movieManagerService.listScreens(orgId, cinemaId);
    return res.json({ success: true, data: result.items, pagination: { total: result.total } });
  } catch (err) { return next(err); }
}

export async function getOrgScreen(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const screenId = Number(req.params.id);
    const screen = await movieManagerService.getScreen(orgId, screenId);
    if (!screen) return res.status(404).json({ success: false, message: 'Screen not found' });
    return res.json({ success: true, data: screen });
  } catch (err) { return next(err); }
}

export async function createOrgScreen(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cinemaId = Number(req.params.cinemaId);
    const screen = await movieManagerService.createScreen(orgId, cinemaId, req.body);
    if (!screen) return res.status(404).json({ success: false, message: 'Cinema not found' });
    return res.status(201).json({ success: true, data: screen });
  } catch (err) { return next(err); }
}

export async function updateOrgScreen(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const screenId = Number(req.params.id);
    const screen = await movieManagerService.updateScreen(orgId, screenId, req.body);
    if (!screen) return res.status(404).json({ success: false, message: 'Screen not found' });
    return res.json({ success: true, data: screen });
  } catch (err) { return next(err); }
}

export async function deleteOrgScreen(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const screenId = Number(req.params.id);
    const result = await movieManagerService.deleteScreen(orgId, screenId);
    if (!result) return res.status(404).json({ success: false, message: 'Screen not found' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
}

// ── Showtimes (organizer) ─────────────────────────────────────────────────────

export async function listOrgShowtimes(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const result = await movieManagerService.listShowtimes(orgId, {
      movieId: req.query.movieId ? Number(req.query.movieId) : undefined,
      cinemaId: req.query.cinemaId ? Number(req.query.cinemaId) : undefined,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 25,
    });
    return res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) { return next(err); }
}

export async function getOrgShowtime(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const showtimeId = Number(req.params.id);
    const showtime = await movieManagerService.getShowtime(orgId, showtimeId);
    if (!showtime) return res.status(404).json({ success: false, message: 'Showtime not found' });
    return res.json({ success: true, data: showtime });
  } catch (err) { return next(err); }
}

export async function createOrgShowtime(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const showtime = await movieManagerService.createShowtime(orgId, req.body);
    if (!showtime) return res.status(403).json({ success: false, message: 'Cinema not in your organization' });
    return res.status(201).json({ success: true, data: showtime });
  } catch (err) { return next(err); }
}

export async function updateOrgShowtime(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const showtimeId = Number(req.params.id);
    const showtime = await movieManagerService.updateShowtime(orgId, showtimeId, req.body);
    if (!showtime) return res.status(404).json({ success: false, message: 'Showtime not found' });
    return res.json({ success: true, data: showtime });
  } catch (err) { return next(err); }
}

export async function deleteOrgShowtime(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const showtimeId = Number(req.params.id);
    const result = await movieManagerService.deleteShowtime(orgId, showtimeId);
    if (!result) return res.status(404).json({ success: false, message: 'Showtime not found' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
}

// ── Price Caps (organizer) ────────────────────────────────────────────────────

export async function listOrgPriceCaps(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const caps = await movieManagerService.listPriceCaps(orgId);
    return res.json({ success: true, data: caps });
  } catch (err) { return next(err); }
}

export async function getOrgPriceCap(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const capId = Number(req.params.id);
    const cap = await movieManagerService.getPriceCap(orgId, capId);
    if (!cap) return res.status(404).json({ success: false, message: 'Price cap not found' });
    return res.json({ success: true, data: cap });
  } catch (err) { return next(err); }
}

export async function createOrgPriceCap(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const cap = await movieManagerService.createPriceCap(orgId, req.body);
    return res.status(201).json({ success: true, data: cap });
  } catch (err) { return next(err); }
}

export async function updateOrgPriceCap(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const capId = Number(req.params.id);
    const cap = await movieManagerService.updatePriceCap(orgId, capId, req.body);
    if (!cap) return res.status(404).json({ success: false, message: 'Price cap not found' });
    return res.json({ success: true, data: cap });
  } catch (err) { return next(err); }
}

export async function deleteOrgPriceCap(req: OrganizerRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.organizerUser!.organizationId;
    const capId = Number(req.params.id);
    const result = await movieManagerService.deletePriceCap(orgId, capId);
    if (!result) return res.status(404).json({ success: false, message: 'Price cap not found' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
}
