/**
 * LayoutVersionSeatRepository — CRUD for seats within a layout version.
 *
 * Seats are immutable snapshots of the screen layout at a point in time.
 * Adding/removing/changing seats creates a new layout version, not an
 * update to existing version seats.
 */

import { getPool } from '../db/pool';
import type {
  LayoutVersionSeatRow,
  LayoutVersionSeatPublic,
  LayoutVersionSeatCreateInput,
} from '../types';

export class LayoutVersionSeatRepository {

  async findByLayoutVersion(layoutVersionId: number): Promise<LayoutVersionSeatRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_version_seats WHERE layout_version_id = $1 ORDER BY row_label, seat_number',
      [layoutVersionId]
    );
    return rows as unknown as LayoutVersionSeatRow[];
  }

  async findByLayoutVersionAndRow(layoutVersionId: number, rowLabel: string): Promise<LayoutVersionSeatRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_version_seats WHERE layout_version_id = $1 AND row_label = $2 ORDER BY seat_number',
      [layoutVersionId, rowLabel]
    );
    return rows as unknown as LayoutVersionSeatRow[];
  }

  async findById(id: number): Promise<LayoutVersionSeatRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM layout_version_seats WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as LayoutVersionSeatRow[])[0] || null;
  }

  async bulkCreate(layoutVersionId: number, seats: LayoutVersionSeatCreateInput[]): Promise<LayoutVersionSeatRow[]> {
    const pool = getPool();
    const created: LayoutVersionSeatRow[] = [];
    for (const seat of seats) {
      const { rows } = await pool.query(
        `INSERT INTO layout_version_seats
         (layout_version_id, row_label, seat_number, seat_type, seat_category,
          x_position, y_position, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          layoutVersionId,
          seat.rowLabel,
          seat.seatNumber,
          seat.seatType ?? 'standard',
          seat.seatCategory ?? 'regular',
          seat.xPosition ?? null,
          seat.yPosition ?? null,
          seat.isAvailable ?? true,
        ]
      );
      created.push(rows[0] as unknown as LayoutVersionSeatRow);
    }
    return created;
  }

  async create(input: LayoutVersionSeatCreateInput): Promise<LayoutVersionSeatRow> {
    const { rows } = await getPool().query(
      `INSERT INTO layout_version_seats
       (layout_version_id, row_label, seat_number, seat_type, seat_category,
        x_position, y_position, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.layoutVersionId,
        input.rowLabel,
        input.seatNumber,
        input.seatType ?? 'standard',
        input.seatCategory ?? 'regular',
        input.xPosition ?? null,
        input.yPosition ?? null,
        input.isAvailable ?? true,
      ]
    );
    return rows[0] as unknown as LayoutVersionSeatRow;
  }

  async update(id: number, input: {
    seatType?: string;
    seatCategory?: string;
    xPosition?: number | null;
    yPosition?: number | null;
    isAvailable?: boolean;
  }): Promise<LayoutVersionSeatRow | null> {
    const pool = getPool();
    const fields: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    let idx = 1;

    if (input.seatType !== undefined) { fields.push(`seat_type = $${idx++}`); params.push(input.seatType); }
    if (input.seatCategory !== undefined) { fields.push(`seat_category = $${idx++}`); params.push(input.seatCategory); }
    if (input.xPosition !== undefined) { fields.push(`x_position = $${idx++}`); params.push(input.xPosition); }
    if (input.yPosition !== undefined) { fields.push(`y_position = $${idx++}`); params.push(input.yPosition); }
    if (input.isAvailable !== undefined) { fields.push(`is_available = $${idx++}`); params.push(input.isAvailable); }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `UPDATE layout_version_seats SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return (rows as LayoutVersionSeatRow[])[0] || null;
  }

  async delete(id: number): Promise<void> {
    await getPool().query('DELETE FROM layout_version_seats WHERE id = $1', [id]);
  }

  toPublic(row: LayoutVersionSeatRow): LayoutVersionSeatPublic {
    return {
      id: row.id,
      layoutVersionId: row.layout_version_id,
      rowLabel: row.row_label,
      seatNumber: row.seat_number,
      seatType: row.seat_type,
      seatCategory: row.seat_category,
      xPosition: row.x_position !== null ? Number(row.x_position) : null,
      yPosition: row.y_position !== null ? Number(row.y_position) : null,
      isAvailable: row.is_available,
    };
  }
}

export const layoutVersionSeatRepository = new LayoutVersionSeatRepository();
export { layoutVersionSeatRepository as default };
