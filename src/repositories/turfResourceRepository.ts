/**
 * Turf resource repository — bookable grounds/courts/zones under a turf_venue.
 */

import { getPool } from '../db/pool';
import type { TurfResourceRow, TurfResourcePublic, TurfResourceCreateInput, TurfResourceUpdateInput } from '../types';

export class TurfResourceRepository {
  async findById(id: number): Promise<TurfResourceRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_resources WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    return (rows as unknown as TurfResourceRow[])[0] || null;
  }

  async findByVenue(venueId: number): Promise<TurfResourceRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_resources WHERE venue_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [venueId]
    );
    return rows as unknown as TurfResourceRow[];
  }

  async findAll(query: { venueId?: number; resourceType?: string; category?: string; page?: number; pageSize?: number }): Promise<{ items: TurfResourcePublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['tr.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.venueId) { where.push(`tr.venue_id = $${idx++}`); params.push(query.venueId); }
    if (query.resourceType) { where.push(`tr.resource_type = $${idx++}`); params.push(query.resourceType); }
    if (query.category) { where.push(`tr.category ILIKE $${idx++}`); params.push(`%${query.category}%`); }
    const whereStr = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_resources tr ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, venue_id, resource_type, category, name, base_price, attributes, is_active, created_at, updated_at FROM turf_resources tr ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as TurfResourcePublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findPublic(query: { category?: string; city?: string; page?: number; pageSize?: number }): Promise<{ items: any[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ["tv.status = 'approved'", 'tr.is_active = true', 'tv.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.category) { where.push(`tr.category ILIKE $${idx++}`); params.push(`%${query.category}%`); }
    if (query.city) { where.push(`tv.city ILIKE $${idx++}`); params.push(`%${query.city}%`); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) FROM turf_resources tr JOIN turf_venues tv ON tr.venue_id = tv.id ${whereStr}`,
      params
    );
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT tr.id, tr.venue_id, tr.resource_type, tr.category, tr.name, tr.base_price, tr.attributes, tr.is_active, tr.created_at, tr.updated_at,
              tv.name as venue_name, tv.city, tv.address, tv.amenities, tv.latitude, tv.longitude,
              (SELECT AVG(rating)::numeric(3,2) FROM turf_reviews WHERE venue_id = tv.id AND deleted_at IS NULL) as avg_rating,
              (SELECT COUNT(*) FROM turf_reviews WHERE venue_id = tv.id AND deleted_at IS NULL) as review_count
       FROM turf_resources tr JOIN turf_venues tv ON tr.venue_id = tv.id ${whereStr}
       ORDER BY review_count DESC NULLS LAST, avg_rating DESC NULLS LAST
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as any[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: TurfResourceCreateInput): Promise<TurfResourceRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_resources (venue_id, resource_type, category, name, base_price, attributes) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [input.venue_id, input.resource_type, input.category, input.name, input.base_price, JSON.stringify(input.attributes ?? {})]
    );
    return (rows as unknown as TurfResourceRow[])[0];
  }

  async update(id: number, input: TurfResourceUpdateInput): Promise<TurfResourceRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(key === 'attributes' ? JSON.stringify(value) : value);
      }
    }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE turf_resources SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as TurfResourceRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE turf_resources SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const turfResourceRepository = new TurfResourceRepository();
