/**
 * Turf venue repository — independent from event-domain venues.
 */

import { getPool } from '../db/pool';
import type { TurfVenueRow, TurfVenuePublic, TurfVenueCreateInput, TurfVenueUpdateInput } from '../types';

export class TurfVenueRepository {
  async findById(id: number): Promise<TurfVenueRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_venues WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    return (rows as unknown as TurfVenueRow[])[0] || null;
  }

  async findByOrganization(organizationId: number): Promise<TurfVenueRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_venues WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [organizationId]
    );
    return rows as unknown as TurfVenueRow[];
  }

  async findAll(query: { organizationId?: number; city?: string; category?: string; status?: string; page?: number; pageSize?: number }): Promise<{ items: TurfVenuePublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['tv.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.organizationId) { where.push(`tv.organization_id = $${idx++}`); params.push(query.organizationId); }
    if (query.city) { where.push(`tv.city ILIKE $${idx++}`); params.push(`%${query.city}%`); }
    if (query.status) { where.push(`tv.status = $${idx++}`); params.push(query.status); }
    const whereStr = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) FROM turf_venues tv ${whereStr}`, params);
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, organization_id, name, address, city, state, country, latitude, longitude, amenities, status, is_active, created_at, updated_at FROM turf_venues tv ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as TurfVenuePublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: TurfVenueCreateInput & { organization_id: number }): Promise<TurfVenueRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_venues (organization_id, name, description, address, city, state, country, latitude, longitude, amenities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [input.organization_id, input.name, input.description ?? null, input.address ?? null, input.city ?? null, input.state ?? null, input.country ?? 'India', input.latitude ?? null, input.longitude ?? null, input.amenities ?? []]
    );
    return (rows as unknown as TurfVenueRow[])[0];
  }

  async update(id: number, input: TurfVenueUpdateInput): Promise<TurfVenueRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(key === 'amenities' ? JSON.stringify(value) : value);
      }
    }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE turf_venues SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as TurfVenueRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE turf_venues SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const turfVenueRepository = new TurfVenueRepository();
