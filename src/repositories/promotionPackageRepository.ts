/**
 * Promotion Package repository — admin-defined fixed-price promotion tiers.
 */

import { getPool } from '../db/pool';
import type {
  PromotionPackageRow,
  PromotionPackagePublic,
  PromotionPackageCreateInput,
  PromotionPackageUpdateInput,
} from '../types';

export class PromotionPackageRepository {
  async findById(id: number): Promise<PromotionPackageRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_packages WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as PromotionPackageRow[])[0] || null;
  }

  async findBySlug(slug: string): Promise<PromotionPackageRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_packages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
      [slug]
    );
    return (rows as unknown as PromotionPackageRow[])[0] || null;
  }

  async findAll(query: {
    page?: number;
    pageSize?: number;
    isActive?: boolean;
    isFeatured?: boolean;
    search?: string;
  } = {}): Promise<{ items: PromotionPackagePublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.isActive !== undefined) { where.push(`is_active = $${idx++}`); params.push(query.isActive); }
    if (query.isFeatured !== undefined) { where.push(`is_featured = $${idx++}`); params.push(query.isFeatured); }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`(name ILIKE $${idx++} OR description ILIKE $${idx - 1})`);
    }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM promotion_packages ${whereStr}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, name, slug, description, price_paise, currency, duration_days, max_impressions,
              priority_weight, eligible_categories, eligible_entity_types, eligible_placements,
              is_active, is_featured, sort_order, created_at, updated_at
       FROM promotion_packages ${whereStr}
       ORDER BY sort_order ASC, created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: rows as unknown as PromotionPackagePublic[],
      total, page, pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async listActive(): Promise<PromotionPackageRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM promotion_packages
       WHERE deleted_at IS NULL AND is_active = true
       ORDER BY sort_order ASC, created_at DESC`
    );
    return rows as unknown as PromotionPackageRow[];
  }

  async create(input: PromotionPackageCreateInput & { created_by_admin_id: number }): Promise<PromotionPackageRow> {
    const { rows } = await getPool().query(
      `INSERT INTO promotion_packages
       (name, slug, description, price_paise, currency, duration_days, max_impressions,
        priority_weight, eligible_categories, eligible_entity_types, eligible_placements,
        is_active, is_featured, sort_order, metadata, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        input.name,
        input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        input.description ?? null,
        input.price_paise,
        'INR',
        input.duration_days,
        input.max_impressions,
        input.priority_weight ?? 50,
        JSON.stringify(input.eligible_categories),
        JSON.stringify(input.eligible_entity_types || ['turf_resource', 'event']),
        JSON.stringify(input.eligible_placements),
        input.is_active ?? true,
        input.is_featured ?? false,
        input.sort_order ?? 0,
        JSON.stringify(input.metadata || {}),
        input.created_by_admin_id,
      ]
    );
    return (rows as unknown as PromotionPackageRow[])[0];
  }

  async update(id: number, input: PromotionPackageUpdateInput): Promise<PromotionPackageRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) { fields.push(`name = $${idx++}`); params.push(input.name); }
    if (input.description !== undefined) { fields.push(`description = $${idx++}`); params.push(input.description); }
    if (input.price_paise !== undefined) { fields.push(`price_paise = $${idx++}`); params.push(input.price_paise); }
    if (input.duration_days !== undefined) { fields.push(`duration_days = $${idx++}`); params.push(input.duration_days); }
    if (input.max_impressions !== undefined) { fields.push(`max_impressions = $${idx++}`); params.push(input.max_impressions); }
    if (input.priority_weight !== undefined) { fields.push(`priority_weight = $${idx++}`); params.push(input.priority_weight); }
    if (input.eligible_categories !== undefined) { fields.push(`eligible_categories = $${idx++}`); params.push(JSON.stringify(input.eligible_categories)); }
    if (input.eligible_entity_types !== undefined) { fields.push(`eligible_entity_types = $${idx++}`); params.push(JSON.stringify(input.eligible_entity_types)); }
    if (input.eligible_placements !== undefined) { fields.push(`eligible_placements = $${idx++}`); params.push(JSON.stringify(input.eligible_placements)); }
    if (input.is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(input.is_active); }
    if (input.is_featured !== undefined) { fields.push(`is_featured = $${idx++}`); params.push(input.is_featured); }
    if (input.sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); params.push(input.sort_order); }
    if (input.metadata !== undefined) { fields.push(`metadata = $${idx++}`); params.push(JSON.stringify(input.metadata)); }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(
      `UPDATE promotion_packages SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return (rows as unknown as PromotionPackageRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE promotion_packages SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const promotionPackageRepository = new PromotionPackageRepository();
