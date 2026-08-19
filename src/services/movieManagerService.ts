/**
 * MovieManagerService — organization-scoped movie management.
 *
 * All operations are scoped to the caller's organization_id.
 * Movies are linked to organizations via cinemas → showtimes.
 */

import { getPool } from '../db/pool';
import { cinemaRepository } from '../repositories/cinemaRepository';
import { cinemaScreenRepository } from '../repositories/cinemaScreenRepository';
import { showtimeRepository } from '../repositories/showtimeRepository';
import { moviePriceCapRepository } from '../repositories/moviePriceCapRepository';
import { movieRepository } from '../repositories/movieRepository';
import { logger } from '../utils/logger';
import type {
  CinemaRow, CinemaPublic,
  CinemaScreenRow, CinemaScreenCreateInput,
  ShowtimeRow, ShowtimePublic,
  MoviePriceCapRow, MoviePriceCapPublic,
  MovieRow, MoviePublic,
} from '../types';

function cinemaToPublic(row: CinemaRow): CinemaPublic {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    pincode: row.pincode,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    phone: row.phone,
    email: row.email,
    facilities: row.facilities,
    organizationId: row.organization_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function showtimeToPublic(row: ShowtimeRow): ShowtimePublic {
  return {
    id: row.id,
    movieId: row.movie_id,
    cinemaId: row.cinema_id,
    screenId: row.screen_id,
    organizationId: row.organization_id,
    showDatetime: row.show_datetime,
    endDatetime: row.end_datetime,
    language: row.language,
    format: row.format,
    price: Number(row.price),
    currency: row.currency,
    totalSeats: row.total_seats,
    availableSeats: row.available_seats,
    bookedSeats: row.booked_seats,
    status: row.status,
    isHidden: row.is_hidden,
  };
}

function movieToPublic(row: MovieRow): MoviePublic {
  const result = {} as MoviePublic;
  result.id = row.id;
  result.title = row.title;
  result.originalTitle = row.original_title;
  result.slug = row.slug;
  result.synopsis = row.synopsis;
  result.genre = row.genre;
  result.language = row.language;
  result.durationMinutes = row.duration_minutes;
  result.cast = row.cast;
  result.director = row.director;
  result.posterUrl = row.poster_url;
  result.backdropUrl = row.backdrop_url;
  result.trailerUrl = row.trailer_url;
  result.rating = row.rating ? Number(row.rating) : null;
  result.censorRating = row.censor_rating;
  result.releaseDate = row.release_date;
  result.status = row.status;
  result.organizationId = row.organization_id;
  result.isFeatured = row.is_featured;
  result.metadata = row.metadata || {};
  result.createdAt = row.created_at;
  result.updatedAt = row.updated_at;
  return result;
}

function priceCapToPublic(row: MoviePriceCapRow): MoviePriceCapPublic {
  return {
    id: row.id,
    organizationId: row.organization_id,
    city: row.city,
    state: row.state,
    maxPricePaise: Number(row.max_price_paise),
    currency: row.currency,
    appliesTo: row.applies_to,
    isActive: row.is_active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MovieManagerService {

  // ── Movies (org-scoped) ──────────────────────────────────────────────────────

  async listMovies(organizationId: number, search?: string): Promise<MoviePublic[]> {
    const orgCinemas = await cinemaRepository.findByOrganization(organizationId);
    const orgCinemaIds = orgCinemas.map((c) => c.id);
    if (orgCinemaIds.length === 0) return [];

    const params: unknown[] = [orgCinemaIds];
    let idx = 2;
    let where = `WHERE s.cinema_id = ANY($1::int[]) AND s.deleted_at IS NULL`;
    if (search) {
      where += ` AND (m.title ILIKE $${idx} OR m.synopsis ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const { rows } = await getPool().query(
      `SELECT DISTINCT m.* FROM movies m
       JOIN showtimes s ON s.movie_id = m.id
       ${where}
       ORDER BY m.created_at DESC`,
      params
    );
    return (rows as unknown[]).map((r) => movieToPublic(r as MovieRow));
  }

  async getMovie(organizationId: number, movieId: number): Promise<MoviePublic | null> {
    const orgCinemas = await cinemaRepository.findByOrganization(organizationId);
    const orgCinemaIds = orgCinemas.map((c) => c.id);
    if (orgCinemaIds.length === 0) return null;

    const { rows } = await getPool().query(
      `SELECT m.* FROM movies m
       JOIN showtimes s ON s.movie_id = m.id
       WHERE s.cinema_id = ANY($1::int[]) AND s.deleted_at IS NULL AND m.id = $2
       LIMIT 1`,
      [orgCinemaIds, movieId]
    );
    const row = (rows as unknown[])[0];
    return row ? movieToPublic(row as MovieRow) : null;
  }

  async createMovie(organizationId: number, input: Record<string, unknown>): Promise<MoviePublic> {
    const { rows } = await getPool().query(
      `INSERT INTO movies (title, original_title, slug, synopsis, genre, language, duration_minutes, cast, director, poster_url, backdrop_url, trailer_url, rating, censor_rating, release_date, status, organization_id, is_featured, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        input.title || 'Untitled',
        input.originalTitle ?? input.title ?? null,
        input.slug || '',
        input.synopsis ?? input.description ?? null,
        input.genre || [],
        input.language || 'Tamil',
        input.durationMinutes ?? input.duration_minutes ?? null,
        input.cast || [],
        input.director ?? null,
        input.posterUrl ?? null,
        input.backdropUrl ?? null,
        input.trailerUrl ?? null,
        input.rating ?? null,
        input.censorRating ?? null,
        input.releaseDate ?? null,
        input.status || 'draft',
        organizationId,
        input.isFeatured ?? false,
        JSON.stringify(input.metadata || {}),
      ]
    );
    return movieToPublic(rows[0] as MovieRow);
  }

  async updateMovie(organizationId: number, movieId: number, input: Record<string, unknown>): Promise<MoviePublic | null> {
    const existing = await this.getMovie(organizationId, movieId);
    if (!existing) return null;

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (input.title !== undefined) { sets.push(`title = $${idx++}`); params.push(input.title); }
    if (input.originalTitle !== undefined) { sets.push(`original_title = $${idx++}`); params.push(input.originalTitle); }
    if (input.slug !== undefined) { sets.push(`slug = $${idx++}`); params.push(input.slug); }
    if (input.synopsis !== undefined || input.description !== undefined) { sets.push(`synopsis = $${idx++}`); params.push(input.synopsis ?? input.description); }
    if (input.genre !== undefined) { sets.push(`genre = $${idx++}`); params.push(input.genre); }
    if (input.language !== undefined) { sets.push(`language = $${idx++}`); params.push(input.language); }
    if (input.durationMinutes !== undefined || input.duration_minutes !== undefined) { sets.push(`duration_minutes = $${idx++}`); params.push(input.durationMinutes ?? input.duration_minutes); }
    if (input.cast !== undefined) { sets.push(`cast = $${idx++}`); params.push(input.cast); }
    if (input.director !== undefined) { sets.push(`director = $${idx++}`); params.push(input.director); }
    if (input.posterUrl !== undefined) { sets.push(`poster_url = $${idx++}`); params.push(input.posterUrl); }
    if (input.backdropUrl !== undefined) { sets.push(`backdrop_url = $${idx++}`); params.push(input.backdropUrl); }
    if (input.trailerUrl !== undefined) { sets.push(`trailer_url = $${idx++}`); params.push(input.trailerUrl); }
    if (input.rating !== undefined) { sets.push(`rating = $${idx++}`); params.push(input.rating); }
    if (input.censorRating !== undefined) { sets.push(`censor_rating = $${idx++}`); params.push(input.censorRating); }
    if (input.releaseDate !== undefined) { sets.push(`release_date = $${idx++}`); params.push(input.releaseDate); }
    if (input.status !== undefined) { sets.push(`status = $${idx++}`); params.push(input.status); }
    if (input.isFeatured !== undefined) { sets.push(`is_featured = $${idx++}`); params.push(input.isFeatured); }
    if (input.metadata !== undefined) { sets.push(`metadata = $${idx++}`); params.push(JSON.stringify(input.metadata)); }

    if (sets.length === 1) return existing;
    params.push(movieId);

    const { rows } = await getPool().query(
      `UPDATE movies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return movieToPublic(rows[0] as MovieRow);
  }

  async deleteMovie(organizationId: number, movieId: number): Promise<boolean> {
    const orgCinemas = await cinemaRepository.findByOrganization(organizationId);
    const orgCinemaIds = orgCinemas.map((c) => c.id);
    if (orgCinemaIds.length === 0) return false;

    const { rows } = await getPool().query(
      `SELECT COUNT(*) as cnt FROM showtimes WHERE movie_id = $1 AND cinema_id = ANY($2::int[]) AND deleted_at IS NULL`,
      [movieId, orgCinemaIds]
    );
    const count = Number((rows as Array<{ cnt: number | string }>)[0]?.cnt ?? 0);
    if (count > 0) return false;

    await getPool().query('DELETE FROM movies WHERE id = $1', [movieId]);
    return true;
  }

  // ── Cinemas (org-scoped) ────────────────────────────────────────────────────

  async listCinemas(organizationId: number): Promise<CinemaPublic[]> {
    const cinemas = await cinemaRepository.findByOrganization(organizationId);
    return cinemas.map((c) => cinemaToPublic(c));
  }

  async getCinema(organizationId: number, cinemaId: number): Promise<CinemaPublic | null> {
    const cinema = await cinemaRepository.findById(cinemaId);
    if (!cinema || cinema.organization_id !== organizationId) return null;
    return cinemaToPublic(cinema);
  }

  async createCinema(organizationId: number, input: Record<string, unknown>): Promise<CinemaPublic> {
    const cinema = await cinemaRepository.create({
      ...input,
      organization_id: organizationId,
    } as unknown as Parameters<typeof cinemaRepository.create>[0]);
    return cinemaToPublic(cinema);
  }

  async updateCinema(organizationId: number, cinemaId: number, input: Record<string, unknown>): Promise<CinemaPublic | null> {
    const cinema = await cinemaRepository.findById(cinemaId);
    if (!cinema || cinema.organization_id !== organizationId) return null;
    const updateInput: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      if (val !== undefined && key !== 'organization_id' && key !== 'id') {
        updateInput[key] = val;
      }
    }
    const updated = await cinemaRepository.update(cinemaId, updateInput as unknown as Partial<import('../types').CinemaCreateInput>);
    return updated ? cinemaToPublic(updated) : null;
  }

  async deleteCinema(organizationId: number, cinemaId: number): Promise<boolean> {
    const cinema = await cinemaRepository.findById(cinemaId);
    if (!cinema || cinema.organization_id !== organizationId) return false;
    await cinemaRepository.softDelete(cinemaId);
    return true;
  }

  // ── Screens (org-scoped) ─────────────────────────────────────────────────────

  async listScreens(organizationId: number, cinemaId?: number): Promise<{ items: CinemaScreenRow[]; total: number }> {
    const cinemas = await cinemaRepository.findByOrganization(organizationId);
    const orgCinemaIds = cinemas.map((c) => c.id);
    if (orgCinemaIds.length === 0) return { items: [], total: 0 };

    let where = 'WHERE cinema_id = ANY($1::int[]) AND is_active = true';
    const params: unknown[] = [orgCinemaIds];
    let idx = 2;
    if (cinemaId) {
      where += ` AND cinema_id = $${idx++}`;
      params.push(cinemaId);
    }

    const { rows } = await getPool().query(
      `SELECT cs.* FROM cinema_screens cs ${where} ORDER BY cs.cinema_id, cs.screen_number`,
      params
    );
    return { items: rows as unknown as CinemaScreenRow[], total: rows.length };
  }

  async getScreen(organizationId: number, screenId: number): Promise<CinemaScreenRow | null> {
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) return null;
    const cinema = await cinemaRepository.findById(screen.cinema_id);
    if (!cinema || cinema.organization_id !== organizationId) return null;
    return screen;
  }

  async createScreen(organizationId: number, cinemaId: number, input: Partial<CinemaScreenRow>): Promise<CinemaScreenRow | null> {
    const cinema = await cinemaRepository.findById(cinemaId);
    if (!cinema || cinema.organization_id !== organizationId) return null;
    return cinemaScreenRepository.create({ ...input, cinemaId } as Parameters<typeof cinemaScreenRepository.create>[0]);
  }

  async updateScreen(organizationId: number, screenId: number, input: Partial<CinemaScreenRow>): Promise<CinemaScreenRow | null> {
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) return null;
    const cinema = await cinemaRepository.findById(screen.cinema_id);
    if (!cinema || cinema.organization_id !== organizationId) return null;
    return cinemaScreenRepository.update(screenId, input);
  }

  async deleteScreen(organizationId: number, screenId: number): Promise<boolean> {
    const screen = await cinemaScreenRepository.findById(screenId);
    if (!screen) return false;
    const cinema = await cinemaRepository.findById(screen.cinema_id);
    if (!cinema || cinema.organization_id !== organizationId) return false;
    await cinemaScreenRepository.softDelete(screenId);
    return true;
  }

  // ── Showtimes (org-scoped) ───────────────────────────────────────────────────

  async listShowtimes(organizationId: number, filters: { movieId?: number; cinemaId?: number; from?: string; to?: string; page?: number; pageSize?: number }): Promise<{ items: ShowtimePublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const cinemas = await cinemaRepository.findByOrganization(organizationId);
    const orgCinemaIds = cinemas.map((c) => c.id);
    if (orgCinemaIds.length === 0) return { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 };

    const page = filters.page || 1;
    const pageSize = Math.min(filters.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;

    const whereClauses: string[] = ['s.cinema_id = ANY($1::int[])', 's.deleted_at IS NULL'];
    const params: unknown[] = [orgCinemaIds];
    let idx = 2;

    if (filters.movieId) { whereClauses.push(`s.movie_id = $${idx++}`); params.push(filters.movieId); }
    if (filters.cinemaId) { whereClauses.push(`s.cinema_id = $${idx++}`); params.push(filters.cinemaId); }
    if (filters.from) { whereClauses.push(`s.show_datetime >= $${idx++}`); params.push(filters.from); }
    if (filters.to) { whereClauses.push(`s.show_datetime <= $${idx++}`); params.push(filters.to); }

    const where = whereClauses.join(' AND ');

    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM showtimes s WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    const { rows } = await getPool().query(
      `SELECT s.* FROM showtimes s WHERE ${where} ORDER BY s.show_datetime DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: (rows as unknown[]).map((r) => showtimeToPublic(r as ShowtimeRow)),
      total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async getShowtime(organizationId: number, showtimeId: number): Promise<ShowtimePublic | null> {
    const { rows } = await getPool().query(
      `SELECT s.* FROM showtimes s
       JOIN cinemas c ON c.id = s.cinema_id
       WHERE s.id = $1 AND s.deleted_at IS NULL AND c.organization_id = $2
       LIMIT 1`,
      [showtimeId, organizationId]
    );
    const row = (rows as unknown[])[0];
    return row ? showtimeToPublic(row as ShowtimeRow) : null;
  }

  async createShowtime(organizationId: number, input: Record<string, unknown>): Promise<ShowtimePublic | null> {
    const cinemaId = Number(input.cinemaId);
    const cinema = await cinemaRepository.findById(cinemaId);
    if (!cinema || cinema.organization_id !== organizationId) return null;

    const showDatetime = String(input.showDatetime || input.startTime || input.show_datetime);
    const duration = Number((input as Record<string, unknown>).durationMinutes || (input as Record<string, unknown>).duration_minutes || 150);
    const endDatetime = new Date(new Date(showDatetime).getTime() + (duration + 30) * 60 * 1000).toISOString();

    const screenId = input.screenId ? Number(input.screenId) : null;
    const movieId = Number(input.movieId);

    // Get seat capacity from screen
    let seatCapacity = 0;
    if (screenId) {
      const screen = await cinemaScreenRepository.findById(screenId);
      if (screen) seatCapacity = screen.seat_capacity;
    }

    const { rows } = await getPool().query(
      `INSERT INTO showtimes (movie_id, cinema_id, screen_id, organization_id, show_datetime, end_datetime, language, format, price, currency, total_seats, available_seats, status, is_hidden, metadata, screen_layout_version_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        movieId, cinemaId, screenId, organizationId,
        showDatetime, endDatetime,
        String(input.language || 'Tamil'),
        String(input.format || '2D'),
        Number(input.price || 0),
        String(input.currency || 'INR'),
        seatCapacity, seatCapacity,
        String(input.status || 'scheduled'),
        input.isHidden ?? false,
        JSON.stringify(input.metadata || (input.seatMap || {})),
        input.screenLayoutVersionId ?? null,
      ]
    );
    return showtimeToPublic(rows[0] as ShowtimeRow);
  }

  async updateShowtime(organizationId: number, showtimeId: number, input: Record<string, unknown>): Promise<ShowtimePublic | null> {
    const existing = await this.getShowtime(organizationId, showtimeId);
    if (!existing) return null;

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (input.movieId !== undefined) { sets.push(`movie_id = $${idx++}`); params.push(Number(input.movieId)); }
    if (input.cinemaId !== undefined) {
      const c = await cinemaRepository.findById(Number(input.cinemaId));
      if (!c || c.organization_id !== organizationId) return null;
      sets.push(`cinema_id = $${idx++}`); params.push(Number(input.cinemaId));
    }
    if (input.screenId !== undefined) { sets.push(`screen_id = $${idx++}`); params.push(input.screenId ? Number(input.screenId) : null); }
    if (input.language !== undefined) { sets.push(`language = $${idx++}`); params.push(String(input.language)); }
    if (input.format !== undefined) { sets.push(`format = $${idx++}`); params.push(String(input.format)); }
    if (input.price !== undefined) { sets.push(`price = $${idx++}`); params.push(Number(input.price)); }
    if (input.currency !== undefined) { sets.push(`currency = $${idx++}`); params.push(String(input.currency)); }
    if (input.status !== undefined) { sets.push(`status = $${idx++}`); params.push(String(input.status)); }
    if (input.isHidden !== undefined) { sets.push(`is_hidden = $${idx++}`); params.push(input.isHidden); }

    // Recompute end_datetime if start changes
    let needEndDatetime = false;
    if (input.showDatetime || input.startTime) {
      const newStart = String(input.showDatetime || input.startTime);
      sets.push(`show_datetime = $${idx++}`);
      params.push(newStart);
      needEndDatetime = true;
    }

    if (needEndDatetime) {
      const movieId = input.movieId || existing.movieId;
      const movieResult = await getPool().query('SELECT duration_minutes FROM movies WHERE id = $1 LIMIT 1', [movieId]);
      const movieRow = (movieResult.rows as Array<{ duration_minutes: number | null }>)[0];
      const duration = movieRow?.duration_minutes || 150;
      const newEnd = new Date(new Date(String(input.showDatetime || input.startTime)).getTime() + (duration + 30) * 60 * 1000).toISOString();
      sets.push(`end_datetime = $${idx++}`);
      params.push(newEnd);
    }

    if (input.screenLayoutVersionId !== undefined) { sets.push(`screen_layout_version_id = $${idx++}`); params.push(input.screenLayoutVersionId ? Number(input.screenLayoutVersionId) : null); }

    if (sets.length === 1) return existing;

    params.push(showtimeId);
    const { rows } = await getPool().query(
      `UPDATE showtimes SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return showtimeToPublic(rows[0] as ShowtimeRow);
  }

  async deleteShowtime(organizationId: number, showtimeId: number): Promise<boolean> {
    const existing = await this.getShowtime(organizationId, showtimeId);
    if (!existing) return false;
    await getPool().query('UPDATE showtimes SET deleted_at = NOW() WHERE id = $1', [showtimeId]);
    return true;
  }

  // ── Price Caps (org-scoped) ──────────────────────────────────────────────────

  async listPriceCaps(organizationId: number): Promise<MoviePriceCapPublic[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_price_caps WHERE organization_id = $1 ORDER BY created_at DESC',
      [organizationId]
    );
    return (rows as unknown[]).map((r) => priceCapToPublic(r as MoviePriceCapRow));
  }

  async getPriceCap(organizationId: number, capId: number): Promise<MoviePriceCapPublic | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_price_caps WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [capId, organizationId]
    );
    const row = (rows as unknown[])[0];
    return row ? priceCapToPublic(row as MoviePriceCapRow) : null;
  }

  async createPriceCap(organizationId: number, input: Record<string, unknown>): Promise<MoviePriceCapPublic> {
    const { rows } = await getPool().query(
      `INSERT INTO movie_price_caps (organization_id, city, state, max_price_paise, currency, applies_to, is_active, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        organizationId,
        String(input.city || ''),
        String(input.state || ''),
        input.maxPricePaise ?? 0,
        String(input.currency || 'INR'),
        String(input.appliesTo || 'all'),
        input.isActive ?? true,
        input.notes ?? null,
      ]
    );
    return priceCapToPublic(rows[0] as MoviePriceCapRow);
  }

  async updatePriceCap(organizationId: number, capId: number, input: Record<string, unknown>): Promise<MoviePriceCapPublic | null> {
    const existing = await this.getPriceCap(organizationId, capId);
    if (!existing) return null;

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (input.city !== undefined) { sets.push(`city = $${idx++}`); params.push(input.city); }
    if (input.state !== undefined) { sets.push(`state = $${idx++}`); params.push(input.state); }
    if (input.maxPricePaise !== undefined) { sets.push(`max_price_paise = $${idx++}`); params.push(input.maxPricePaise); }
    if (input.currency !== undefined) { sets.push(`currency = $${idx++}`); params.push(input.currency); }
    if (input.appliesTo !== undefined) { sets.push(`applies_to = $${idx++}`); params.push(input.appliesTo); }
    if (input.isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.isActive); }
    if (input.notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(input.notes); }

    params.push(capId);
    const { rows } = await getPool().query(
      `UPDATE movie_price_caps SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return priceCapToPublic(rows[0] as MoviePriceCapRow);
  }

  async deletePriceCap(organizationId: number, capId: number): Promise<boolean> {
    const existing = await this.getPriceCap(organizationId, capId);
    if (!existing) return false;
    await getPool().query('DELETE FROM movie_price_caps WHERE id = $1', [capId]);
    return true;
  }
}

export const movieManagerService = new MovieManagerService();
