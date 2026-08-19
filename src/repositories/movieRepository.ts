/**
 * MovieRepository — full CRUD, search/filter/pagination, soft delete for the
 * movies table.
 */

import { getPool } from '../db/pool';
import type { MovieRow, MoviePublic, MovieCreateInput } from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toPublic(row: Record<string, unknown>): MoviePublic {
  return {
    id: row.id as number,
    title: row.title as string,
    originalTitle: row.original_title as string | null,
    slug: row.slug as string,
    synopsis: row.synopsis as string | null,
    genre: row.genre as string[],
    language: row.language as string,
    durationMinutes: row.duration_minutes as number | null,
    cast: row.cast as string[],
    director: row.director as string | null,
    posterUrl: row.poster_url as string | null,
    backdropUrl: row.backdrop_url as string | null,
    trailerUrl: row.trailer_url as string | null,
    rating: row.rating != null ? Number(row.rating) : null,
    censorRating: row.censor_rating as string | null,
    releaseDate: row.release_date as string | null,
    status: row.status as MovieRow['status'],
    organizationId: row.organization_id as number | null,
    isFeatured: row.is_featured as boolean,
    metadata: (row.metadata as Record<string, unknown>) || {},
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class MovieRepository {
  async findById(id: number): Promise<MovieRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movies WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as MovieRow[])[0] || null;
  }

  async findBySlug(slug: string): Promise<MovieRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movies WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
      [slug]
    );
    return (rows as unknown as MovieRow[])[0] || null;
  }

  async findByOrganization(
    organizationId: number,
    query: { page?: number; pageSize?: number; status?: string } = {}
  ): Promise<PaginatedResult<MoviePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ['deleted_at IS NULL', 'organization_id = $1'];
    const params: unknown[] = [organizationId];
    let idx = 2;
    if (query.status) { whereClauses.push(`status = $${idx++}`); params.push(query.status); }

    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM movies WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM movies WHERE ${where} ORDER BY release_date DESC NULLS LAST, created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findNowShowing(query: { page?: number; pageSize?: number; city?: string } = {}): Promise<PaginatedResult<MoviePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ["status = 'now_showing'", "deleted_at IS NULL"];
    const params: unknown[] = [];
    let idx = 1;

    if (query.city) {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM showtimes s JOIN cinemas c ON c.id = s.cinema_id WHERE s.movie_id = movies.id AND c.city = $${idx++} AND s.deleted_at IS NULL AND s.status IN ('on_sale', 'scheduled'))`
      );
      params.push(query.city);
    }

    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM movies WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM movies WHERE ${where} ORDER BY is_featured DESC, release_date DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findFeatured(): Promise<MovieRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM movies WHERE status = 'now_showing' AND is_featured = true AND deleted_at IS NULL ORDER BY release_date DESC NULLS LAST`
    );
    return rows as unknown as MovieRow[];
  }

  async search(query: {
    q?: string;
    city?: string;
    genre?: string;
    language?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PaginatedResult<MoviePublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;

    if (query.status) { whereClauses.push(`status = $${idx++}`); params.push(query.status); }
    if (query.language) { whereClauses.push(`language ILIKE $${idx++}`); params.push(query.language); }
    if (query.genre) { whereClauses.push(`$${idx++} = ANY(genre)`); params.push(query.genre); }
    if (query.q) {
      whereClauses.push(`(title ILIKE $${idx++} OR original_title ILIKE $${idx++})`);
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (query.city) {
      whereClauses.push(
        `EXISTS (SELECT 1 FROM showtimes s JOIN cinemas c ON c.id = s.cinema_id WHERE s.movie_id = movies.id AND c.city = $${idx++} AND s.deleted_at IS NULL AND s.status IN ('on_sale', 'scheduled'))`
      );
      params.push(query.city);
    }

    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM movies WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM movies WHERE ${where} ORDER BY is_featured DESC, release_date DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: MovieCreateInput & { organization_id?: number }): Promise<MovieRow> {
    const slug = input.slug || generateSlug(input.title);
    const { rows } = await getPool().query(
      `INSERT INTO movies (title, original_title, slug, synopsis, genre, language, duration_minutes, cast, director, poster_url, backdrop_url, trailer_url, rating, censor_rating, release_date, status, organization_id, is_featured, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        input.title,
        input.originalTitle || null,
        slug,
        input.synopsis || null,
        input.genre || [],
        input.language || 'Tamil',
        input.durationMinutes ?? null,
        input.cast || [],
        input.director || null,
        input.posterUrl || null,
        input.backdropUrl || null,
        input.trailerUrl || null,
        input.rating ?? null,
        input.censorRating || null,
        input.releaseDate || null,
        input.status || 'coming_soon',
        input.organization_id ?? null,
        input.isFeatured ?? false,
        '{}',
      ]
    );
    return rows[0] as unknown as MovieRow;
  }

  async update(id: number, input: Partial<MovieCreateInput>): Promise<MovieRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    const map: Record<string, [string, unknown]> = {
      title: ['title', input.title],
      originalTitle: ['original_title', input.originalTitle],
      slug: ['slug', input.slug],
      synopsis: ['synopsis', input.synopsis],
      genre: ['genre', input.genre],
      language: ['language', input.language],
      durationMinutes: ['duration_minutes', input.durationMinutes],
      cast: ['cast', input.cast],
      director: ['director', input.director],
      posterUrl: ['poster_url', input.posterUrl],
      backdropUrl: ['backdrop_url', input.backdropUrl],
      trailerUrl: ['trailer_url', input.trailerUrl],
      rating: ['rating', input.rating],
      censorRating: ['censor_rating', input.censorRating],
      releaseDate: ['release_date', input.releaseDate],
      status: ['status', input.status],
      isFeatured: ['is_featured', input.isFeatured],
    };

    for (const [key, value] of Object.entries(map)) {
      if (value[1] !== undefined) {
        sets.push(`${key[0] === key[0].toLowerCase() ? key : key.toLowerCase()} = $${idx++}`);
        params.push(value[1]);
      }
    }

    if (sets.length === 1) return this.findById(id);
    const { rows } = await getPool().query(
      `UPDATE movies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as MovieRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE movies SET deleted_at = NOW() WHERE id = $1', [id]);
  }

  async existsBySlug(slug: string, excludeId?: number): Promise<boolean> {
    const params: unknown[] = [slug];
    let sql = 'SELECT 1 FROM movies WHERE slug = $1';
    if (excludeId) { sql += ' AND id != $2'; params.push(excludeId); }
    sql += ' LIMIT 1';
    const { rows } = await getPool().query(sql, params);
    return rows.length > 0;
  }
}

export const movieRepository = new MovieRepository();
