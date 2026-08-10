"use strict";
/**
 * Turf coupon service.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfCouponService = exports.TurfCouponService = void 0;
const turfCouponRepository_1 = require("../repositories/turfCouponRepository");
const errorHandler_1 = require("../middleware/errorHandler");
class TurfCouponService {
    async create(orgId, input) {
        return turfCouponRepository_1.turfCouponRepository.create({ ...input, organization_id: orgId });
    }
    async listByOrganization(orgId) {
        return turfCouponRepository_1.turfCouponRepository.findByOrganization(orgId);
    }
    async validate(orgId, code, bookingAmount, userId) {
        const coupon = await turfCouponRepository_1.turfCouponRepository.findByCode(orgId, code);
        if (!coupon)
            throw new errorHandler_1.AppError('Invalid coupon code', 400);
        if (parseFloat(coupon.min_booking_amount) > bookingAmount) {
            throw new errorHandler_1.AppError(`Minimum booking amount ₹${coupon.min_booking_amount} required`, 400);
        }
        if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
            throw new errorHandler_1.AppError('Coupon usage limit reached', 400);
        }
        const usages = await turfCouponRepository_1.turfCouponRepository.findUsageByUserAndCoupon(userId, coupon.id);
        if (usages.length >= coupon.per_user_limit) {
            throw new errorHandler_1.AppError('You have already used this coupon', 400);
        }
        let discount = 0;
        if (coupon.discount_type === 'percentage') {
            discount = Math.round((bookingAmount * parseFloat(coupon.discount_value)) / 100 * 100) / 100;
            if (coupon.max_discount)
                discount = Math.min(discount, parseFloat(coupon.max_discount));
        }
        else {
            discount = parseFloat(coupon.discount_value);
        }
        return { coupon, discount };
    }
}
exports.TurfCouponService = TurfCouponService;
exports.turfCouponService = new TurfCouponService();
