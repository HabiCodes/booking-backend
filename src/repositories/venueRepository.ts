/**
 * Venue repository.
 */

import { getPool } from '../db/pool';
import type { VenueRow, VenuePublic, VenueCreateInput } from '../types';

export class VenueRepository {
  async findById(id: number): Promise<VenueRow | null> {
    const { rows } = await getPool().query('SELECT * FROM venues WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
    return (rows as unknown as VenueRow[])[0] || null;
  }

  async findByOrganization(organizationId: number): Promise<VenueRow[]> {
    const { rows } = await getPool().query('SELECT * FROM venues WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [organizationId]);
    return rows as unknown as VenueRow[];
  }

  async findAll(query: { organizationId?: number; page?: number; pageSize?: number; search?: string; isActive?: boolean }): Promise<{ items: VenuePublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.organizationId) { whereClauses.push(`organization_id = $${idx++}`); params.push(query.organizationId); }
    if (query.isActive !== undefined) { whereClauses.push(`is_active = $${idx++}`); params.push(query.isActive); }
    if (query.search) { params.push(`%${query.search}%`, `%${query.search}%`); whereClauses.push(`(name ILIKE $${idx++} OR city ILIKE $${idx - 1})`); }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) as total FROM venues ${where}`, params);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, organization_id, name, address, city, state, country, latitude, longitude, capacity, notes, is_active, created_at, updated_at FROM venues ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as VenuePublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: VenueCreateInput & { organization_id: number | null }): Promise<VenueRow> {
    const { rows } = await getPool().query(
      `INSERT INTO venues (organization_id, name, address, city, state, country, latitude, longitude, capacity, seating_map, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [input.organization_id, input.name, input.address ?? null, input.city ?? null, input.state ?? null, input.country ?? null, input.latitude ?? null, input.longitude ?? null, input.capacity ?? null, JSON.stringify(input.seating_map || {}), input.notes ?? null]
    );
    return (rows as unknown as VenueRow[])[0];
  }

  async update(id: number, input: Record<string, unknown>): Promise<VenueRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) { fields.push(`${key} = $${idx++}`); params.push(key === 'seating_map' ? JSON.stringify(value) : value); }
    }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE venues SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as VenueRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE venues SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const venueRepository = new VenueRepository();
