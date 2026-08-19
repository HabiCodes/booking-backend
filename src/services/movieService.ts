/**
 * MovieService — business logic layer for movies.
 *
 * All amounts are in INTEGER paise.
 * All timestamps are TIMESTAMPTZ (IST).
 */

import { getPool } from '../db/pool';
import { logger } from '../utils/logger';
import { movieRepository } from '../repositories/movieRepository';
import type {
  MovieRow, MoviePublic, MovieCreateInput,
} from '../types';

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

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toPublic(row: MovieRow): MoviePublic {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.original_title,
    slug: row.slug,
    synopsis: row.synopsis,
    genre: row.genre,
    language: row.language,
    durationMinutes: row.duration_minutes,
    cast: row.cast,
    director: row.director,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    rating: row.rating ? Number(row.rating) : null,
    censorRating: row.censor_rating,
    releaseDate: row.release_date,
    status: row.status,
    organizationId: row.organization_id,
    isFeatured: row.is_featured,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MovieService {

  // ── Public ──────────────────────────────────────────────────────────────────

  async listPublic(query: MovieListQuery): Promise<PaginatedResult<MoviePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 20, 100);

    const result = await movieRepository.findNowShowing({
      page, pageSize, city: query.city,
    });

    let items = result.items;
    if (query.status === 'ended') {
      // Fetch ended movies via separate query
      const allResult = await movieRepository.findByOrganization(0, { page, pageSize });
      items = allResult.items.filter((m) => m.status === 'ended');
    } else if (query.status === 'coming_soon') {
      items = result.items.filter((m: MoviePublic) => m.status === 'coming_soon');
    }

    return {
      items: query.status === 'coming_soon' ? items : result.items,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.ceil(result.total / pageSize) || 1,
    };
  }

  async getPublicDetail(slugOrId: string): Promise<MoviePublic | null> {
    const byId = Number(slugOrId);
    if (Number.isFinite(byId) && byId > 0) {
      const row = await movieRepository.findById(byId);
      if (!row || row.status === 'coming_soon') return null;
      return toPublic(row);
    }
    const row = await movieRepository.findBySlug(slugOrId);
    if (!row || row.status === 'coming_soon') return null;
    return toPublic(row);
  }

  async listFeatured(_limit?: number): Promise<MoviePublic[]> {
    const rows = await movieRepository.findFeatured();
    return rows.map(toPublic);
  }

  async listGenres(): Promise<string[]> {
    const result = await getPool().query(
      'SELECT DISTINCT genre FROM movies WHERE deleted_at IS NULL ORDER BY genre',
    );
    return (result.rows as Array<{ genre: string }>).map((r) => r.genre).filter(Boolean);
  }

  async listLanguages(): Promise<string[]> {
    const result = await getPool().query(
      'SELECT DISTINCT language FROM movies WHERE deleted_at IS NULL ORDER BY language',
    );
    return (result.rows as Array<{ language: string }>).map((r) => r.language).filter(Boolean);
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  async listAdmin(query: { page?: number; pageSize?: number; search?: string; organizationId?: number } = {}): Promise<PaginatedResult<MoviePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const organizationId = query.organizationId || 0;

    if (query.search) {
      const result = await movieRepository.search({
        q: query.search,
        page, pageSize,
      });
      return { items: result.items, total: result.total, page, pageSize, totalPages: Math.ceil(result.total / pageSize) || 1 };
    }

    const result = await movieRepository.findByOrganization(organizationId, { page, pageSize });
    return { ...result, page, pageSize, totalPages: Math.ceil(result.total / pageSize) || 1 };
  }

  async create(input: Partial<MovieCreateInput> & { organizationId?: number }): Promise<MovieRow> {
    return movieRepository.create(input as MovieCreateInput & { organization_id?: number });
  }

  async update(id: number, input: Partial<MovieCreateInput>): Promise<MovieRow | null> {
    return movieRepository.update(id, input);
  }

  async remove(id: number): Promise<void> {
    return movieRepository.softDelete(id);
  }

  async publish(id: number): Promise<MovieRow | null> {
    return movieRepository.update(id, { status: 'now_showing' });
  }

  async archive(id: number): Promise<MovieRow | null> {
    return movieRepository.update(id, { status: 'ended' });
  }
}

export const movieService = new MovieService();
