/**
 * CinemaScreenRepository — CRUD for cinema_screens, the physical auditorium
 * definition within a cinema.
 */

import { getPool } from '../db/pool';
import type { CinemaScreenRow, CinemaScreenCreateInput } from '../types';

export class CinemaScreenRepository {
  async findById(id: number): Promise<CinemaScreenRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinema_screens WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as CinemaScreenRow[])[0] || null;
  }

  async findByCinema(cinemaId: number): Promise<CinemaScreenRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM cinema_screens WHERE cinema_id = $1 AND is_active = true ORDER BY screen_number',
      [cinemaId]
    );
    return rows as unknown as CinemaScreenRow[];
  }

  async findByOrganization(
    organizationId: number,
    query: { page?: number; pageSize?: number; cinemaId?: number } = {}
  ): Promise<{ items: CinemaScreenRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses = ['cs.cinema_id IN (SELECT id FROM cinemas WHERE organization_id = $1 AND deleted_at IS NULL)'];
    const params: unknown[] = [organizationId];
    let idx = 2;
    if (query.cinemaId) { whereClauses.push(`cs.cinema_id = $${idx++}`); params.push(query.cinemaId); }

    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM cinema_screens cs WHERE ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT cs.* FROM cinema_screens cs WHERE ${where} ORDER BY cs.cinema_id, cs.screen_number LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as CinemaScreenRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: CinemaScreenCreateInput): Promise<CinemaScreenRow> {
    const { rows } = await getPool().query(
      `INSERT INTO cinema_screens (cinema_id, screen_number, name, seat_capacity, screen_type, sound_system, screen_width, screen_height, row_labels, seats_per_row, seat_start_number, seat_types, pricing_rules, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.cinemaId, input.screenNumber, input.name || null, input.seatCapacity,
        input.screenType || 'standard', input.soundSystem || 'dolby',
        null, null,
        input.rowLabels || [], input.seatsPerRow || [],
        input.seatStartNumber ?? 1, input.seatTypes || {}, input.pricingRules || {}, true,
      ]
    );
    return rows[0] as unknown as CinemaScreenRow;
  }

  async update(id: number, input: Partial<CinemaScreenCreateInput>): Promise<CinemaScreenRow | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
    if (input.seatCapacity !== undefined) { sets.push(`seat_capacity = $${idx++}`); params.push(input.seatCapacity); }
    if (input.screenType !== undefined) { sets.push(`screen_type = $${idx++}`); params.push(input.screenType); }
    if (input.soundSystem !== undefined) { sets.push(`sound_system = $${idx++}`); params.push(input.soundSystem); }
    if (input.pricingRules !== undefined) { sets.push(`pricing_rules = $${idx++}`); params.push(input.pricingRules); }

    if (sets.length === 1) return this.findById(id);
    const { rows } = await getPool().query(
      `UPDATE cinema_screens SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      [...params, id]
    );
    return (rows as unknown as CinemaScreenRow[])[0] || null;
  }

  async updateCapacity(id: number, seatCapacity: number): Promise<void> {
    await getPool().query(
      'UPDATE cinema_screens SET seat_capacity = $1, updated_at = NOW() WHERE id = $2',
      [seatCapacity, id]
    );
  }

  async findAll(query: { cinemaId?: number; page?: number; pageSize?: number; includeInactive?: boolean } = {}): Promise<{ items: CinemaScreenRow[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.cinemaId) { whereClauses.push(`cinema_id = $${idx++}`); params.push(query.cinemaId); }
    if (!query.includeInactive) { whereClauses.push('is_active = true'); }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM cinema_screens ${where}`, params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT * FROM cinema_screens ${where} ORDER BY cinema_id, screen_number LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as CinemaScreenRow[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE cinema_screens SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
  }
}

export const cinemaScreenRepository = new CinemaScreenRepository();
