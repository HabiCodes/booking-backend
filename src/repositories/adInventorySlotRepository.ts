/**
 * Ad Inventory Slot repository — controls sponsored slot limits per location/category/placement.
 */

import { getPool } from '../db/pool';
import type { AdInventorySlotRow, AdInventorySlotPublic, AdInventorySlotCreateInput, AdInventorySlotUpdateInput } from '../types';

export class AdInventorySlotRepository {
  async findById(id: number): Promise<AdInventorySlotRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM ad_inventory_slots WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as AdInventorySlotRow[])[0] || null;
  }

  async findByKey(locationKey: string, category: string, placement: string): Promise<AdInventorySlotRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM ad_inventory_slots
       WHERE location_key = $1 AND category = $2 AND placement = $3 AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
      [locationKey, category, placement]
    );
    return (rows as unknown as AdInventorySlotRow[])[0] || null;
  }

  async findAll(query: { page?: number; pageSize?: number; isActive?: boolean } = {}): Promise<{ items: AdInventorySlotPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.isActive !== undefined) { where.push(`is_active = $${idx++}`); params.push(query.isActive); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM ad_inventory_slots ${whereStr}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, location_key, category, placement, max_slots, is_active, created_at, updated_at
       FROM ad_inventory_slots ${whereStr}
       ORDER BY location_key, category, placement
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: rows as unknown as AdInventorySlotPublic[],
      total, page, pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async create(input: AdInventorySlotCreateInput & { created_by_admin_id: number }): Promise<AdInventorySlotRow> {
    const { rows } = await getPool().query(
      `INSERT INTO ad_inventory_slots
       (location_key, category, placement, max_slots, is_active, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [input.location_key, input.category, input.placement, input.max_slots, input.is_active ?? true, input.created_by_admin_id]
    );
    return (rows as unknown as AdInventorySlotRow[])[0];
  }

  async update(id: number, input: AdInventorySlotUpdateInput): Promise<AdInventorySlotRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.max_slots !== undefined) { fields.push(`max_slots = $${idx++}`); params.push(input.max_slots); }
    if (input.is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(input.is_active); }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(
      `UPDATE ad_inventory_slots SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return (rows as unknown as AdInventorySlotRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE ad_inventory_slots SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const adInventorySlotRepository = new AdInventorySlotRepository();
