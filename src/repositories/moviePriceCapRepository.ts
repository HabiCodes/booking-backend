/**
 * MoviePriceCapRepository — configurable price caps (e.g., Tamil Nadu govt
 * regulations). Applied at showtime creation/update to enforce max seat
 * prices.
 */

import { getPool } from '../db/pool';
import type { MoviePriceCapRow, MoviePriceCapPublic, MoviePriceCapCreateInput } from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class MoviePriceCapRepository {
  async findActive(
    organizationId: number | null,
    city: string,
    state: string,
    appliesTo?: string
  ): Promise<MoviePriceCapRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM movie_price_caps
       WHERE is_active = true
         AND ($1::integer IS NULL OR organization_id IS NULL OR organization_id = $1)
         AND city = $2 AND state = $3
         AND ($4::text IS NULL OR applies_to = 'all' OR applies_to = $4)
       ORDER BY organization_id IS NULL DESC, id ASC
       LIMIT 1`,
      [organizationId, city, state, appliesTo || null]
    );
    return (rows as unknown as MoviePriceCapRow[])[0] || null;
  }

  async findApplicable(
    organizationId: number | null,
    city: string,
    state: string,
    seatType: string
  ): Promise<MoviePriceCapRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM movie_price_caps
       WHERE is_active = true
         AND ($1::integer IS NULL OR organization_id IS NULL OR organization_id = $1)
         AND city = $2 AND state = $3
         AND (applies_to = 'all' OR applies_to = $4)
       ORDER BY organization_id IS NULL DESC, id ASC
       LIMIT 1`,
      [organizationId, city, state, seatType]
    );
    return (rows as unknown as MoviePriceCapRow[])[0] || null;
  }

  async findByOrganization(
    organizationId: number,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<MoviePriceCapPublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query(
      'SELECT COUNT(*) as total FROM movie_price_caps WHERE organization_id = $1',
      [organizationId]
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      'SELECT * FROM movie_price_caps WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [organizationId, pageSize, offset]
    );
    return { items: rows as unknown as MoviePriceCapPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findAll(query: { page?: number; pageSize?: number } = {}): Promise<PaginatedResult<MoviePriceCapPublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query('SELECT COUNT(*) as total FROM movie_price_caps');
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      'SELECT * FROM movie_price_caps ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [pageSize, offset]
    );
    return { items: rows as unknown as MoviePriceCapPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: MoviePriceCapCreateInput & { organization_id?: number }): Promise<MoviePriceCapRow> {
    const { rows } = await getPool().query(
      `INSERT INTO movie_price_caps (organization_id, city, state, max_price_paise, currency, applies_to, is_active, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.organization_id ?? null,
        input.city, input.state,
        input.maxPricePaise ?? null, input.currency || 'INR',
        input.appliesTo || 'all', input.isActive ?? true, input.notes || null,
      ]
    );
    return rows[0] as unknown as MoviePriceCapRow;
  }

  async update(id: number, input: Partial<MoviePriceCapCreateInput>): Promise<MoviePriceCapRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;
    if (input.city !== undefined) { sets.push(`city = $${idx++}`); params.push(input.city); }
    if (input.state !== undefined) { sets.push(`state = $${idx++}`); params.push(input.state); }
    if (input.maxPricePaise !== undefined) { sets.push(`max_price_paise = $${idx++}`); params.push(input.maxPricePaise); }
    if (input.appliesTo !== undefined) { sets.push(`applies_to = $${idx++}`); params.push(input.appliesTo); }
    if (input.isActive !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.isActive); }
    if (input.notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(input.notes); }
    if (sets.length === 1) {
      const { rows } = await getPool().query('SELECT * FROM movie_price_caps WHERE id = $1 LIMIT 1', [id]);
      return (rows as unknown as MoviePriceCapRow[])[0] || null;
    }
    const { rows } = await getPool().query(
      `UPDATE movie_price_caps SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as MoviePriceCapRow[])[0] || null;
  }

  async findById(id: number): Promise<(MoviePriceCapRow & { organization_id: number | null }) | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM movie_price_caps WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as MoviePriceCapRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE movie_price_caps SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
  }
}

export const moviePriceCapRepository = new MoviePriceCapRepository();
