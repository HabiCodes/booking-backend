/**
 * CinemaRepository — full CRUD, location search, pagination for the
 * cinemas table.
 */

import { getPool } from '../db/pool';
import type { CinemaRow, CinemaPublic, CinemaCreateInput } from '../types';

interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function toPublic(row: Record<string, unknown>): CinemaPublic {
  return {
    id: row.id as number,
    name: row.name as string,
    slug: row.slug as string,
    address: row.address as string,
    city: row.city as string,
    state: row.state as string,
    country: row.country as string,
    pincode: row.pincode as string | null,
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    phone: row.phone as string | null,
    email: row.email as string | null,
    facilities: row.facilities as string[],
    organizationId: row.organization_id as number | null,
    status: row.status as CinemaRow['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class CinemaRepository {
  async findById(id: number): Promise<CinemaRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinemas WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as CinemaRow[])[0] || null;
  }

  async findBySlug(slug: string): Promise<CinemaRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinemas WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
      [slug]
    );
    return (rows as unknown as CinemaRow[])[0] || null;
  }

  async findByCity(
    city: string,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<CinemaPublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM cinemas WHERE deleted_at IS NULL AND status = 'active' AND city = $1`,
      [city]
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      'SELECT * FROM cinemas WHERE deleted_at IS NULL AND status = $1 AND city = $2 ORDER BY name LIMIT $3 OFFSET $4',
      ['active', city, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async findByOrganization(organizationId: number): Promise<CinemaRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinemas WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY name',
      [organizationId]
    );
    return rows as unknown as CinemaRow[];
  }

  async findNearby(
    lat: number,
    lng: number,
    radiusKm: number,
    query: { page?: number; pageSize?: number } = {}
  ): Promise<PaginatedResult<CinemaPublic>> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM cinemas
       WHERE deleted_at IS NULL AND status = 'active' AND latitude IS NOT NULL AND longitude IS NOT NULL
       AND SQRT(POWER(latitude - $1, 2) + POWER(longitude - $2, 2)) <= $3`,
      [lat, lng, radiusKm]
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT *, SQRT(POWER(latitude - $1, 2) + POWER(longitude - $2, 2)) as distance
       FROM cinemas
       WHERE deleted_at IS NULL AND status = $3 AND latitude IS NOT NULL AND longitude IS NOT NULL
       AND SQRT(POWER(latitude - $1, 2) + POWER(longitude - $2, 2)) <= $4
       ORDER BY distance LIMIT $5 OFFSET $6`,
      [lat, lng, 'active', radiusKm, pageSize, offset]
    );
    return { items: rows.map(toPublic), total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: CinemaCreateInput & { organization_id?: number }): Promise<CinemaRow> {
    const slug = input.slug || generateSlug(input.name);
    const { rows } = await getPool().query(
      `INSERT INTO cinemas (name, slug, address, city, state, country, pincode, latitude, longitude, phone, email, facilities, organization_id, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.name, slug, input.address, input.city, input.state || 'Tamil Nadu', input.country || 'India',
        input.pincode || null, input.latitude ?? null, input.longitude ?? null,
        input.phone || null, input.email || null, input.facilities || [],
        input.organization_id ?? null, input.status || 'active', '{}',
      ]
    );
    return rows[0] as unknown as CinemaRow;
  }

  async update(id: number, input: Partial<CinemaCreateInput>): Promise<CinemaRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    const map: Record<string, [string, unknown]> = {
      name: ['name', input.name],
      address: ['address', input.address],
      city: ['city', input.city],
      state: ['state', input.state],
      country: ['country', input.country],
      pincode: ['pincode', input.pincode],
      latitude: ['latitude', input.latitude],
      longitude: ['longitude', input.longitude],
      phone: ['phone', input.phone],
      email: ['email', input.email],
      facilities: ['facilities', input.facilities],
      status: ['status', input.status],
    };

    for (const [, value] of Object.entries(map)) {
      if (value[1] !== undefined) {
        sets.push(`${value[0]} = $${idx++}`);
        params.push(value[1]);
      }
    }

    if (sets.length === 1) return this.findById(id);
    const { rows } = await getPool().query(
      `UPDATE cinemas SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as CinemaRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE cinemas SET deleted_at = NOW() WHERE id = $1', [id]);
  }

  async findScreens(cinemaId: number) {
    const { rows } = await getPool().query(
      'SELECT * FROM cinema_screens WHERE cinema_id = $1 AND is_active = true ORDER BY screen_number',
      [cinemaId]
    );
    return rows as unknown as import('../types').CinemaScreenRow[];
  }
}

export const cinemaRepository = new CinemaRepository();
