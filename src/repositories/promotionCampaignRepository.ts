/**
 * Promotion Campaign repository — CRUD and queries for promotion_campaigns table.
 */

import { getPool } from '../db/pool';
import type {
  PromotionCampaignRow,
  PromotionCampaignPublic,
  PromotionCampaignCreateInput,
  PromotionCampaignUpdateInput,
  PromotionCampaignStatus,
} from '../types';

export class PromotionCampaignRepository {
  async findById(id: number): Promise<PromotionCampaignRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_campaigns WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
      [id]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async findByPaymentOrderId(paymentOrderId: string): Promise<PromotionCampaignRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_campaigns WHERE payment_order_id = $1 AND deleted_at IS NULL LIMIT 1',
      [paymentOrderId]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async listByOrganization(organizationId: number, query: {
    page?: number;
    pageSize?: number;
    status?: PromotionCampaignStatus;
    search?: string;
  } = {}): Promise<{ items: PromotionCampaignPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['pc.deleted_at IS NULL', 'pc.organization_id = $1'];
    const params: unknown[] = [organizationId];
    let idx = 2;
    if (query.status) { where.push(`pc.status = $${idx++}`); params.push(query.status); }
    if (query.search) {
      params.push(`%${query.search}%`);
      where.push(`pc.entity_name ILIKE $${idx++}`);
    }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM promotion_campaigns pc ${whereStr}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT pc.*, pp.name as package_name
       FROM promotion_campaigns pc
       JOIN promotion_packages pp ON pp.id = pc.package_id
       ${whereStr}
       ORDER BY pc.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: rows as unknown as PromotionCampaignPublic[],
      total, page, pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async listActive(query: {
    entityType?: string;
    entityId?: number;
    placement?: string;
    category?: string;
    locationKey?: string;
    startAt?: string;
    endAt?: string;
  } = {}): Promise<PromotionCampaignRow[]> {
    const where: string[] = [
      'pc.deleted_at IS NULL',
      "pc.status = 'ACTIVE'",
      'pc.start_at <= NOW()',
      'pc.end_at >= NOW()',
      'pc.impressions_delivered < pc.max_impressions',
    ];
    const params: unknown[] = [];
    let idx = 1;
    if (query.entityType) { where.push(`pc.entity_type = $${idx++}`); params.push(query.entityType); }
    if (query.entityId) { where.push(`pc.entity_id = $${idx++}`); params.push(query.entityId); }
    if (query.placement) {
      where.push(`EXISTS (SELECT 1 FROM promotion_packages pp WHERE pp.id = pc.package_id AND pp.eligible_placements::jsonb @> $${idx++}::jsonb)`);
      params.push(JSON.stringify([query.placement]));
    }
    if (query.category) {
      where.push(`EXISTS (SELECT 1 FROM promotion_packages pp WHERE pp.id = pc.package_id AND pp.eligible_categories::jsonb @> $${idx++}::jsonb)`);
      params.push(JSON.stringify([query.category]));
    }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows } = await getPool().query(
      `SELECT pc.*, pp.name as package_name, pp.eligible_categories, pp.eligible_entity_types, pp.eligible_placements
       FROM promotion_campaigns pc
       JOIN promotion_packages pp ON pp.id = pc.package_id
       ${whereStr}
       ORDER BY pc.priority_weight DESC, pc.created_at ASC`,
      params
    );
    return rows as unknown as PromotionCampaignRow[];
  }

  async listEligibleForRanking(query: {
    placement: string;
    category?: string;
    locationKey?: string;
    entityType?: string;
  }): Promise<PromotionCampaignRow[]> {
    const where: string[] = [
      'pc.deleted_at IS NULL',
      "pc.status = 'ACTIVE'",
      'pc.start_at <= NOW()',
      'pc.end_at >= NOW()',
      'pc.impressions_delivered < pc.max_impressions',
    ];
    const params: unknown[] = [];
    let idx = 1;
    if (query.entityType) { where.push(`pc.entity_type = $${idx++}`); params.push(query.entityType); }
    if (query.category) {
      where.push(`EXISTS (SELECT 1 FROM promotion_packages pp WHERE pp.id = pc.package_id AND pp.eligible_categories::jsonb @> $${idx++}::jsonb)`);
      params.push(JSON.stringify([query.category]));
    }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows } = await getPool().query(
      `SELECT pc.*, pp.name as package_name, pp.eligible_categories, pp.eligible_placements
       FROM promotion_campaigns pc
       JOIN promotion_packages pp ON pp.id = pc.package_id
       ${whereStr}
       ORDER BY pc.priority_weight DESC`,
      params
    );
    return rows as unknown as PromotionCampaignRow[];
  }

  async create(input: PromotionCampaignCreateInput & {
    organization_id: number;
    package_id: number;
    priority_weight: number;
    config_snapshot: Record<string, unknown>;
    created_by_organizer_id?: number | null;
  }): Promise<PromotionCampaignRow> {
    const { rows } = await getPool().query(
      `INSERT INTO promotion_campaigns
       (organization_id, package_id, entity_type, entity_id, entity_name,
        entity_image_url, entity_location, start_at, end_at, max_impressions,
        priority_weight, config_snapshot, status, created_by_organizer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING_PAYMENT',$13) RETURNING *`,
      [
        input.organization_id,
        input.package_id,
        input.entity_type,
        input.entity_id,
        input.entity_name,
        input.entity_image_url ?? null,
        input.entity_location ?? null,
        input.start_at,
        input.end_at,
        input.max_impressions,
        input.priority_weight,
        JSON.stringify(input.config_snapshot),
        input.created_by_organizer_id ?? null,
      ]
    );
    return (rows as unknown as PromotionCampaignRow[])[0];
  }

  async update(id: number, input: PromotionCampaignUpdateInput): Promise<PromotionCampaignRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.status !== undefined) { fields.push(`status = $${idx++}`); params.push(input.status); }
    if (input.start_at !== undefined) { fields.push(`start_at = $${idx++}`); params.push(input.start_at); }
    if (input.end_at !== undefined) { fields.push(`end_at = $${idx++}`); params.push(input.end_at); }
    if (input.priority_weight !== undefined) { fields.push(`priority_weight = $${idx++}`); params.push(input.priority_weight); }
    if (input.paused_reason !== undefined) { fields.push(`paused_reason = $${idx++}`); params.push(input.paused_reason); }
    if (input.rejection_reason !== undefined) { fields.push(`rejection_reason = $${idx++}`); params.push(input.rejection_reason); }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(
      `UPDATE promotion_campaigns SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async activate(id: number, paymentOrderId: string, totalSpendPaise: number): Promise<PromotionCampaignRow | null> {
    const { rows } = await getPool().query(
      `UPDATE promotion_campaigns
       SET status = 'ACTIVE', payment_order_id = $2, total_spend_paise = $3, approved_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, paymentOrderId, totalSpendPaise]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async incrementImpressions(id: number, count: number = 1): Promise<PromotionCampaignRow | null> {
    const { rows } = await getPool().query(
      `UPDATE promotion_campaigns
       SET impressions_delivered = impressions_delivered + $2
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, count]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async incrementClicks(id: number): Promise<void> {
    await getPool().query(
      `UPDATE promotion_campaigns SET clicks = clicks + 1 WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
  }

  async cancel(id: number): Promise<PromotionCampaignRow | null> {
    const { rows } = await getPool().query(
      `UPDATE promotion_campaigns SET status = 'CANCELLED', cancelled_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async softDelete(id: number): Promise<void> {
    await getPool().query('UPDATE promotion_campaigns SET deleted_at = NOW() WHERE id = $1', [id]);
  }
}

export const promotionCampaignRepository = new PromotionCampaignRepository();
