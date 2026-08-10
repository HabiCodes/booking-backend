/**
 * Turf coupon repository.
 */

import { getPool } from '../db/pool';
import type { TurfCouponRow, TurfCouponPublic, TurfCouponUsageRow } from '../types';

export class TurfCouponRepository {
  async findById(id: number): Promise<TurfCouponRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_coupons WHERE id = $1 LIMIT 1', [id]);
    return (rows as TurfCouponRow[])[0] || null;
  }

  async findByCode(orgId: number, code: string): Promise<TurfCouponRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_coupons WHERE organization_id = $1 AND UPPER(code) = UPPER($2) AND is_active = TRUE AND valid_until > NOW() LIMIT 1',
      [orgId, code]
    );
    return (rows as TurfCouponRow[])[0] || null;
  }

  async findByOrganization(orgId: number): Promise<TurfCouponRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_coupons WHERE organization_id = $1 ORDER BY created_at DESC',
      [orgId]
    );
    return rows as TurfCouponRow[];
  }

  async create(input: Record<string, unknown>): Promise<TurfCouponRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_coupons (organization_id, code, description, discount_type, discount_value, min_booking_amount, max_discount, usage_limit, per_user_limit, valid_until, applicable_resource_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [input.organization_id, input.code, input.description ?? null, input.discount_type, input.discount_value, input.min_booking_amount ?? 0, input.max_discount ?? null, input.usage_limit ?? null, input.per_user_limit ?? 1, input.valid_until, input.applicable_resource_ids ?? []]
    );
    return rows[0] as TurfCouponRow;
  }

  async incrementUsage(id: number): Promise<void> {
    await getPool().query('UPDATE turf_coupons SET used_count = used_count + 1 WHERE id = $1', [id]);
  }

  async createUsage(input: { coupon_id: number; booking_id: number; user_id: number; discount_amount: number }): Promise<TurfCouponUsageRow> {
    const { rows } = await getPool().query(
      'INSERT INTO turf_coupon_usages (coupon_id, booking_id, user_id, discount_amount) VALUES ($1,$2,$3,$4) RETURNING *',
      [input.coupon_id, input.booking_id, input.user_id, input.discount_amount]
    );
    return rows[0] as TurfCouponUsageRow;
  }

  async findUsageByUserAndCoupon(userId: number, couponId: number): Promise<TurfCouponUsageRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_coupon_usages WHERE user_id = $1 AND coupon_id = $2',
      [userId, couponId]
    );
    return rows as TurfCouponUsageRow[];
  }
}

export const turfCouponRepository = new TurfCouponRepository();
