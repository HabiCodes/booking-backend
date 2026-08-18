import { Request, Response, NextFunction } from 'express';
import { movieService } from '../services/movieService';
import { cinemaService } from '../services/cinemaService';
import { showtimeService } from '../services/showtimeService';

interface MovieListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  city?: string;
  status?: string;
  genre?: string;
  language?: string;
  featured?: boolean;
  sortBy?: string;
  sortOrder?: string;
}

// ── Movies ───────────────────────────────────────────────────────────────────

export async function listMovies(req: Request, res: Response, next: NextFunction) {
  try {
    const query: MovieListQuery = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      search: req.query.search as string | undefined,
      city: req.query.city as string | undefined,
      status: req.query.status as MovieListQuery['status'],
      genre: req.query.genre as string | undefined,
      language: req.query.language as string | undefined,
      featured: req.query.featured === 'true' ? true : undefined,
      sortBy: req.query.sortBy as MovieListQuery['sortBy'],
      sortOrder: req.query.sortOrder as MovieListQuery['sortOrder'],
    };

    const result = await movieService.listPublic(query);

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json({
      success: true,
      data: result.items,
      pagination: {
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      },
    });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getMovie(req: Request, res: Response, next: NextFunction) {
  try {
    const slug = req.params.slug || req.params.id;
    const detail = await movieService.getPublicDetail(slug);
    if (!detail) return res.status(404).json({ success: false, message: 'Movie not found' });

    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
    return res.json({ success: true, data: detail });
  } catch (err) {
    return next(err);
  }
}

export async function getFeaturedMovies(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 8;
    const items = await movieService.listFeatured();
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getGenres(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await movieService.listGenres();
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getLanguages(req: Request, res: Response, next: NextFunction) {
  try {
    const items = await movieService.listLanguages();
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

// ── Cinemas ──────────────────────────────────────────────────────────────────

export async function listCinemas(req: Request, res: Response, next: NextFunction) {
  try {
    const city = req.query.city as string | undefined;
    const state = req.query.state as string | undefined;
    const items = await cinemaService.listActive(city, state);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getCinema(req: Request, res: Response, next: NextFunction) {
  try {
    const idOrSlug = req.params.id || req.params.slug;
    const cinema = await cinemaService.getActive(idOrSlug);
    if (!cinema) return res.status(404).json({ success: false, message: 'Cinema not found' });
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=300');
    return res.json({ success: true, data: cinema });
  } catch (err) {
    return next(err);
  }
}

export async function getCinemasByCity(req: Request, res: Response, next: NextFunction) {
  try {
    const city = req.params.city;
    const items = await cinemaService.listByCity(city);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json({ success: true, data: items });
    return;
  } catch (err) {
    return next(err);
  }
}

// ── Screens ──────────────────────────────────────────────────────────────────

export async function getScreens(req: Request, res: Response, next: NextFunction) {
  try {
    const cinemaId = parseInt(req.params.cinemaId, 10);
    if (!Number.isFinite(cinemaId)) {
      return res.status(400).json({ success: false, message: 'Invalid cinema ID' });
    }
    const screens = await cinemaService.getScreens(cinemaId);
    res.json({ success: true, data: screens });
    return;
  } catch (err) {
    return next(err);
  }
}

// ── Showtimes ────────────────────────────────────────────────────────────────

export async function listShowtimes(req: Request, res: Response, next: NextFunction) {
  try {
    const movieId = req.query.movieId ? Number(req.query.movieId) : undefined;
    const city = req.query.city as string | undefined;
    const cinemaId = req.query.cinemaId ? Number(req.query.cinemaId) : undefined;
    const date = req.query.date as string | undefined;

    const showtimes = await showtimeService.listPublic({ movieId, city, cinemaId, date });
    res.json({ success: true, data: showtimes });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getShowtime(req: Request, res: Response, next: NextFunction) {
  try {
    const showtimeId = parseInt(req.params.id, 10);
    if (!Number.isFinite(showtimeId)) {
      return res.status(400).json({ success: false, message: 'Invalid showtime ID' });
    }
    const showtime = await showtimeService.getPublicDetail(showtimeId);
    if (!showtime) return res.status(404).json({ success: false, message: 'Showtime not found' });
    res.json({ success: true, data: showtime });
    return;
  } catch (err) {
    return next(err);
  }
}

export async function getCitiesWithMovies(req: Request, res: Response, next: NextFunction) {
  try {
    const cities = await showtimeService.getActiveCities();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.json({ success: true, data: cities });
    return;
  } catch (err) {
    return next(err);
  }
}
