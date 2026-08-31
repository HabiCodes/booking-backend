import { Request, Response, NextFunction } from 'express';
import { movieService } from '../services/movieService';
import { cinemaService } from '../services/cinemaService';
import { cinemaScreenRepository } from '../repositories/cinemaScreenRepository';
import { showtimeService } from '../services/showtimeService';
import { moviePriceCapService } from '../services/moviePriceCapService';
import type { AdminRequest } from '../middleware/adminAuth';
import { AppError } from '../middleware/errorHandler';
import { cinemaRepository } from '../repositories/cinemaRepository';
import { moviePriceCapRepository } from '../repositories/moviePriceCapRepository';

// ── Org enforcement helpers ───────────────────────────────────────────────────
// Ownership chain: screen → cinema → organization

async function enforceCinemaOrg(req: AdminRequest, cinemaId: number): Promise<void> {
  const adminOrgId = req.admin?.organizationId ?? null;
  if (adminOrgId === null) return; // super_admin
  const cinema = await cinemaRepository.findById(cinemaId);
  if (!cinema) throw new AppError('Cinema not found', 404);
  if (cinema.organization_id !== adminOrgId) {
    throw new AppError('Not authorized for this cinema', 403);
  }
}

async function enforceScreenOrg(req: AdminRequest, screenId: number): Promise<void> {
  const screen = await cinemaScreenRepository.findById(screenId);
  if (!screen) throw new AppError('Screen not found', 404);
  await enforceCinemaOrg(req, screen.cinema_id);
}

async function enforceShowtimeOrg(req: AdminRequest, showtimeId: number): Promise<void> {
  const { rows } = await getPool().query(
    'SELECT cinema_id FROM showtimes WHERE id = $1 LIMIT 1',
    [showtimeId]
  );
  const row = (rows as Array<{ cinema_id: number }>)[0];
  if (!row) throw new AppError('Showtime not found', 404);
  await enforceCinemaOrg(req, row.cinema_id);
}

async function enforcePriceCapOrg(req: AdminRequest, priceCapId: number): Promise<void> {
  const cap = await moviePriceCapRepository.findById(priceCapId);
  if (!cap) throw new AppError('Price cap not found', 404);
  const adminOrgId = req.admin?.organizationId ?? null;
  if (adminOrgId === null) return; // super_admin
  if (cap.organization_id !== adminOrgId) {
    throw new AppError('Not authorized for this price cap', 403);
  }
}

// Need pool for showtime org check
import { getPool } from '../db/pool';

// ── Movies (admin) ────────────────────────────────────────────────────────────

export async function listAdminMovies(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const result = await movieService.listAdmin({
      page, pageSize,
      search: req.query.search as string | undefined,
      organizationId: req.admin?.organizationId ?? null,
    });
    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    // For org-scoped admins, force the movie into their organization
    const orgId = req.admin?.organizationId;
    const payload = { ...req.body };
    if (orgId != null && !payload.organizationId && !payload.organization_id) {
      payload.organizationId = orgId;
    }
    const movie = await movieService.create(payload);
    return res.status(201).json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

export async function updateMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const orgId = req.admin?.organizationId;
    // Verify org ownership (super_admin orgId=null bypasses)
    if (orgId != null) {
      const existing = await movieService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to modify this movie' });
      }
    }
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
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await movieService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this movie' });
      }
    }
    await movieService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function publishMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await movieService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to publish this movie' });
      }
    }
    const movie = await movieService.publish(id);
    return res.json({ success: true, data: movie });
  } catch (err) {
    return next(err);
  }
}

export async function archiveMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await movieService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to archive this movie' });
      }
    }
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
    const items = await cinemaService.listAll(city, req.admin?.organizationId ?? null);
    return res.json({ success: true, data: items });
  } catch (err) {
    return next(err);
  }
}

export async function createCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.admin?.organizationId;
    const payload = { ...req.body };
    if (orgId != null && !payload.organizationId && !payload.organization_id) {
      payload.organizationId = orgId;
    }
    const cinema = await cinemaService.create(payload);
    return res.status(201).json({ success: true, data: cinema });
  } catch (err) {
    return next(err);
  }
}

export async function updateCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await cinemaService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to modify this cinema' });
      }
    }
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
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await cinemaService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this cinema' });
      }
    }
    await cinemaService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function toggleCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    const orgId = req.admin?.organizationId;
    if (orgId != null) {
      const existing = await cinemaService.findById(id);
      if (!existing || existing.organization_id !== orgId) {
        return res.status(403).json({ success: false, message: 'Not authorized to modify this cinema' });
      }
    }
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
    await enforceCinemaOrg(req, cinemaId);
    const screen = await cinemaService.createScreen(cinemaId, req.body);
    return res.status(201).json({ success: true, data: screen });
  } catch (err) {
    return next(err);
  }
}

export async function updateScreen(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    await enforceScreenOrg(req, screenId);
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
    await enforceScreenOrg(req, screenId);
    await cinemaService.removeScreen(screenId);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function getScreenWithLayout(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) return res.status(404).json({ success: false, message: 'Screen not found' });
    await enforceScreenOrg(req, screenId);
    const layout = await cinemaService.getScreenCurrentLayout(screenId);
    const versions = await cinemaService.getScreenLayoutVersions(screenId);
    return res.json({ success: true, data: { screen, currentLayout: layout, versions } });
  } catch (err) {
    return next(err);
  }
}

export async function listScreenLayoutVersions(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    await enforceScreenOrg(req, screenId);
    const versions = await cinemaService.getScreenLayoutVersions(screenId);
    return res.json({ success: true, data: versions });
  } catch (err) {
    return next(err);
  }
}

export async function setScreenCurrentLayout(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const screenId = parseInt(req.params.screenId, 10);
    await enforceScreenOrg(req, screenId);
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
    await enforceScreenOrg(req, screenId);
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
    await enforceScreenOrg(req, screenId);
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
    const orgId = req.admin?.organizationId ?? null;
    const result = await showtimeService.listAdmin({ movieId, cinemaId, page, pageSize, organizationId: orgId });
    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createShowtime(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    // Verify the cinema belongs to the admin's organization
    const cinemaId = parseInt((req.body as { cinema_id?: number }).cinema_id as unknown as string, 10);
    if (Number.isFinite(cinemaId)) {
      await enforceCinemaOrg(req, cinemaId);
    }
    const showtime = await showtimeService.create(req.body);
    return res.status(201).json({ success: true, data: showtime });
  } catch (err) {
    return next(err);
  }
}

export async function updateShowtime(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await enforceShowtimeOrg(req, id);
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
    await enforceShowtimeOrg(req, id);
    await showtimeService.remove(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimesForCinema(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const cinemaId = parseInt(req.params.cinemaId, 10);
    await enforceCinemaOrg(req, cinemaId);
    const showtimes = await showtimeService.listByCinema(cinemaId);
    return res.json({ success: true, data: showtimes });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimesForMovie(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const movieId = parseInt(req.params.movieId, 10);
    const orgId = req.admin?.organizationId ?? null;
    const showtimes = await showtimeService.listByMovie(movieId, orgId);
    return res.json({ success: true, data: showtimes });
  } catch (err) {
    return next(err);
  }
}

export async function getShowtimeSummary(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const orgId = req.admin?.organizationId ?? null;
    const stats = await showtimeService.getStats(orgId);
    return res.json({ success: true, data: stats });
  } catch (err) {
    return next(err);
  }
}

// ── Price Caps (admin) ────────────────────────────────────────────────────────

export async function listPriceCaps(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 25, 100);
    const orgId = req.admin?.organizationId;

    // Super-admin (orgId=null) sees all price caps across organizations.
    // Org-scoped admin sees only their organization's caps.
    const result = orgId != null
      ? await moviePriceCapService.findByOrganization(orgId, { page, pageSize })
      : await moviePriceCapService.findAll({ page, pageSize });

    res.json({ success: true, data: result.items, pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function createPriceCap(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const adminOrgId = req.admin?.organizationId ?? null;
    const payload = { ...(req.body as Record<string, unknown>) };
    // Org-scoped admin: force price cap into their organization, ignore client-supplied org_id
    if (adminOrgId !== null) {
      payload.organization_id = adminOrgId;
    }
    const cap = await moviePriceCapService.create(payload);
    return res.status(201).json({ success: true, data: cap });
  } catch (err) {
    return next(err);
  }
}

export async function updatePriceCap(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id, 10);
    await enforcePriceCapOrg(req, id);
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
    await enforcePriceCapOrg(req, id);
    await moviePriceCapService.softDelete(id);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}