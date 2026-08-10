"use strict";
/**
 * Turf coupon repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfCouponRepository = exports.TurfCouponRepository = void 0;
const pool_1 = require("../db/pool");
class TurfCouponRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_coupons WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByCode(orgId, code) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_coupons WHERE organization_id = $1 AND UPPER(code) = UPPER($2) AND is_active = TRUE AND valid_until > NOW() LIMIT 1', [orgId, code]);
        return rows[0] || null;
    }
    async findByOrganization(orgId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_coupons WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]);
        return rows;
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_coupons (organization_id, code, description, discount_type, discount_value, min_booking_amount, max_discount, usage_limit, per_user_limit, valid_until, applicable_resource_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [input.organization_id, input.code, input.description ?? null, input.discount_type, input.discount_value, input.min_booking_amount ?? 0, input.max_discount ?? null, input.usage_limit ?? null, input.per_user_limit ?? 1, input.valid_until, input.applicable_resource_ids ?? []]);
        return rows[0];
    }
    async incrementUsage(id) {
        await (0, pool_1.getPool)().query('UPDATE turf_coupons SET used_count = used_count + 1 WHERE id = $1', [id]);
    }
    async createUsage(input) {
        const { rows } = await (0, pool_1.getPool)().query('INSERT INTO turf_coupon_usages (coupon_id, booking_id, user_id, discount_amount) VALUES ($1,$2,$3,$4) RETURNING *', [input.coupon_id, input.booking_id, input.user_id, input.discount_amount]);
        return rows[0];
    }
    async findUsageByUserAndCoupon(userId, couponId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_coupon_usages WHERE user_id = $1 AND coupon_id = $2', [userId, couponId]);
        return rows;
    }
}
exports.TurfCouponRepository = TurfCouponRepository;
exports.turfCouponRepository = new TurfCouponRepository();
