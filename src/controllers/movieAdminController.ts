import { Request, Response, NextFunction } from 'express';
import { movieService } from '../services/movieService';
import { cinemaService } from '../services/cinemaService';
import { showtimeService } from '../services/showtimeService';
import { moviePriceCapService } from '../services/moviePriceCapService';
import type { AdminRequest } from '../middleware/adminAuth';

// ── Movies (admin) ────────────────────────────────────────────────────────────

export async function listAdminMovies(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const result = await movieService.listAdmin({ page, pageSize, search: req.query.search as string | undefined });
    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const movie = await movieService.create(req.body);
    return res.status(201).json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

export async function updateMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const movie = await movieService.update(id, req.body);
    if (!movie) return res.status(404).json({ success: false, message: 'Movie not found' });
    return res.json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

export async function deleteMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await movieService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function publishMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const movie = await movieService.publish(id);
    return res.json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

export async function archiveMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const movie = await movieService.archive(id);
    return res.json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

// ── Cinemas (admin) ───────────────────────────────────────────────────────────

export async function listAdminCinemas(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const city = req.query.city as string | undefined;
    const items = await cinemaService.listAll(city);
    return res.json({ success: true, data: items });
  } catch (err) {
    return next(err);
  }
}

export async function createCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const cinema = await cinemaService.create(req.body);
    return res.status(201).json({ success: true, data: cinema });
  } catch (err) {
    return next(err);
  }
}

export async function updateCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const cinema = await cinemaService.update(id, req.body);
    if (!cinema) return res.status(404).json({ success: false, message: 'Cinema not found' });
    return res.json({ success: true, data: cinema });
  } catch (err) {
    return next(err);
  }
}

export async function deleteCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await cinemaService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function toggleCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const cinema = await cinemaService.toggleActive(id, req.body?.isActive);
    return res.json({ success: true, data: cinema });
  } catch (err) {
    return next(err);
  }
}

// ── Screens (admin) ───────────────────────────────────────────────────────────

export async function createScreen(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const cinemaId = parseInt(req.params.cinemaId, 10);
    const screen = await cinemaService.createScreen(cinemaId, req.body);
    return res.status(201).json({ success: true, data: screen });
  } catch (err) {
    return next(err);
  }
}

export async function updateScreen(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const screen = await cinemaService.updateScreen(screenId, req.body);
    if (!screen) return res.status(404).json({ success: false, message: 'Screen not found' });
    return res.json({ success: true, data: screen });
  } catch (err) {
    return next(err);
  }
}

export async function deleteScreen(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    await cinemaService.removeScreen(screenId);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function getScreenWithLayout(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const screen = await cinemaService.getScreens(parseInt(req.params.cinemaId, 10));
    const found = screen.find((s) => s.id === screenId);
    if (!found) return res.status(404).json({ success: false, message: 'Screen not found' });
    const layout = await cinemaService.getScreenCurrentLayout(screenId);
    const versions = await cinemaService.getScreenLayoutVersions(screenId);
    return res.json({ success: true, data: { screen: found, currentLayout: layout, versions } });
  } catch (err) {
    return next(err);
  }
}

export async function listScreenLayoutVersions(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const versions = await cinemaService.getScreenLayoutVersions(screenId);
    return res.json({ success: true, data: versions });
  } catch (err) {
    return next(err);
  }
}

export async function setScreenCurrentLayout(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const versionId = parseInt(req.params.versionId, 10);
    const updated = await cinemaService.setScreenCurrentLayout(screenId, versionId);
    if (!updated) return res.status(404).json({ success: false, message: 'Layout version not found' });
    return res.json({ success: true, data: updated });
  } catch (err) {
    return next(err);
  }
}

export async function createScreenLayoutVersion(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const { name, description } = req.body;
    const version = await cinemaService.createScreenLayoutVersion(screenId, name, description);
    return res.status(201).json({ success: true, data: version });
  } catch (err) {
    return next(err);
  }
}

export async function syncScreenLayout(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const result = await cinemaService.syncScreenLayout(screenId);
    if (!result) return res.status(404).json({ success: false, message: 'No current layout version to sync' });
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

// ── Showtimes (admin) ─────────────────────────────────────────────────────────

export async function listAdminShowtimes(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const movieId = req.query.movieId ? Number(req.query.movieId) : undefined;
    const cinemaId = req.query.cinemaId ? Number(req.query.cinemaId) : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const result = await showtimeService.listAdmin({ movieId, cinemaId, page, pageSize });
    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createShowtime(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const showtime = await showtimeService.create(req.body);
    return res.status(201).json({ success: true, data: showtime });
  } catch (err) {
    return next(err);
  }
}

export async function updateShowtime(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const showtime = await showtimeService.update(id, req.body);
    if (!showtime) return res.status(404).json({ success: false, message: 'Showtime not found' });
    return res.json({ success: true, data: showtime });
  } catch (err) {
    return next(err);
  }
}

export async function deleteShowtime(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await showtimeService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimesForCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const cinemaId = parseInt(req.params.cinemaId, 10);
    const showtimes = await showtimeService.listByCinema(cinemaId);
    return res.json({ success: true, data: showtimes });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimesForMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const movieId = parseInt(req.params.movieId, 10);
    const showtimes = await showtimeService.listByMovie(movieId);
    return res.json({ success: true, data: showtimes });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimeSummary(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const stats = await showtimeService.getStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    return next(err);
  }
}

// ── Price Caps (admin) ────────────────────────────────────────────────────────

export async function listPriceCaps(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const organizationId = req.admin?.id ?? 0;
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const result = await moviePriceCapService.findByOrganization(organizationId, { page, pageSize });
    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createPriceCap(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const cap = await moviePriceCapService.create(req.body);
    return res.status(201).json({ success: true, data: cap });
  } catch (err) {
    return next(err);
  }
}

export async function updatePriceCap(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const cap = await moviePriceCapService.update(id, req.body);
    if (!cap) return res.status(404).json({ success: false, message: 'Price cap not found' });
    return res.json({ success: true, data: cap });
  } catch (err) {
    return next(err);
  }
}

export async function deletePriceCap(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await moviePriceCapService.softDelete(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}