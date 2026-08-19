/**
 * LayoutVersionRepository — CRUD for cinema screen layout versions.
 *
 * Layout versions track historical seat layouts. Each screen can have multiple
 * versions over time (renovations, reconfigurations). One version per screen
 * is marked is_current = true.
 */

import { getPool } from '../db/pool';
import type {
  LayoutVersionRow,
  LayoutVersionPublic,
  LayoutVersionCreateInput,
} from '../types';

export class LayoutVersionRepository {

  async findAll(filters?: { screenId?: number; cinemaId?: number; isCurrent?: boolean }): Promise<LayoutVersionRow[]> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: (number | boolean)[] = [];
    let idx = 1;

    if (filters?.screenId) {
      conditions.push(`lv.screen_id = $${idx++}`);
      params.push(filters.screenId);
    }
    if (filters?.cinemaId) {
      conditions.push(`cs.cinema_id = $${idx++}`);
      params.push(filters.cinemaId);
    }
    if (filters?.isCurrent !== undefined) {
      conditions.push(`lv.is_current = $${idx++}`);
      params.push(filters.isCurrent);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT lv.* FROM layout_versions lv
       JOIN cinema_screens cs ON cs.id = lv.screen_id
       ${where}
       ORDER BY lv.screen_id, lv.version_number`,
      params
    );
    return rows as unknown as LayoutVersionRow[];
  }

  async findById(id: number): Promise<LayoutVersionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_versions WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as LayoutVersionRow[])[0] || null;
  }

  async findByScreen(screenId: number): Promise<LayoutVersionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_versions WHERE screen_id = $1 ORDER BY version_number',
      [screenId]
    );
    return rows as unknown as LayoutVersionRow[];
  }

  async findCurrentByScreen(screenId: number): Promise<LayoutVersionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_versions WHERE screen_id = $1 AND is_current = true LIMIT 1',
      [screenId]
    );
    return (rows as LayoutVersionRow[])[0] || null;
  }

  async create(input: LayoutVersionCreateInput): Promise<LayoutVersionRow> {
    const pool = getPool();

    // Determine version number: max + 1 for this screen
    const { rows: maxRows } = await pool.query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM layout_versions WHERE screen_id = $1',
      [input.screenId]
    );
    const versionNumber = input.versionNumber ?? (maxRows[0] as { next: number }).next;

    const { rows } = await pool.query(
      `INSERT INTO layout_versions
       (screen_id, version_number, name, description, seat_capacity,
        row_labels, seats_per_row, seat_start_number, pricing_rules, is_current)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
       RETURNING *`,
      [
        input.screenId,
        versionNumber,
        input.name ?? null,
        input.description ?? null,
        input.seatCapacity,
        input.rowLabels ?? [],
        input.seatsPerRow ?? [],
        input.seatStartNumber ?? 1,
        input.pricingRules ?? {},
      ]
    );
    return rows[0] as unknown as LayoutVersionRow;
  }

  async update(id: number, input: Partial<LayoutVersionCreateInput> & { isActive?: boolean }): Promise<LayoutVersionRow | null> {
    const pool = getPool();
    const fields: string[] = [];
    const params: (string | number | boolean | unknown)[] = [];
    let idx = 1;

    if (input.name !== undefined) { fields.push(`name = $${idx++}`); params.push(input.name); }
    if (input.description !== undefined) { fields.push(`description = $${idx++}`); params.push(input.description); }
    if (input.seatCapacity !== undefined) { fields.push(`seat_capacity = $${idx++}`); params.push(input.seatCapacity); }
    if (input.rowLabels !== undefined) { fields.push(`row_labels = $${idx++}`); params.push(input.rowLabels); }
    if (input.seatsPerRow !== undefined) { fields.push(`seats_per_row = $${idx++}`); params.push(input.seatsPerRow); }
    if (input.pricingRules !== undefined) { fields.push(`pricing_rules = $${idx++}`); params.push(input.pricingRules); }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE layout_versions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return (rows as LayoutVersionRow[])[0] || null;
  }

  async setCurrent(screenId: number, versionId: number): Promise<void> {
    const pool = getPool();
    await pool.query(
      'UPDATE layout_versions SET is_current = (id = $1), updated_at = NOW() WHERE screen_id = $2',
      [versionId, screenId]
    );
  }

  async delete(id: number): Promise<void> {
    await getPool().query('DELETE FROM layout_versions WHERE id = $1', [id]);
  }

  toPublic(row: LayoutVersionRow): LayoutVersionPublic {
    return {
      id: row.id,
      screenId: row.screen_id,
      versionNumber: row.version_number,
      name: row.name,
      description: row.description,
      seatCapacity: row.seat_capacity,
      rowLabels: row.row_labels,
      seatsPerRow: row.seats_per_row,
      seatStartNumber: row.seat_start_number,
      pricingRules: row.pricing_rules,
      isActive: row.is_active,
      isCurrent: row.is_current,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const layoutVersionRepository = new LayoutVersionRepository();
export { layoutVersionRepository as default };
