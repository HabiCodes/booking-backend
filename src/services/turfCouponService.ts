/**
 * Turf coupon service.
 */

import { turfCouponRepository } from '../repositories/turfCouponRepository';
import { AppError } from '../middleware/errorHandler';

export class TurfCouponService {
  async create(orgId: number, input: { code: string; description?: string | null; discount_type: string; discount_value: number; min_booking_amount?: number; max_discount?: number | null; usage_limit?: number | null; per_user_limit?: number; valid_until: string; applicable_resource_ids?: number[] }) {
    return turfCouponRepository.create({ ...input, organization_id: orgId });
  }

  async listByOrganization(orgId: number) {
    return turfCouponRepository.findByOrganization(orgId);
  }

  async validate(orgId: number, code: string, bookingAmount: number, userId: number) {
    const coupon = await turfCouponRepository.findByCode(orgId, code);
    if (!coupon) throw new AppError('Invalid coupon code', 400);
    if (parseFloat(coupon.min_booking_amount) > bookingAmount) {
      throw new AppError(`Minimum booking amount ₹${coupon.min_booking_amount} required`, 400);
    }
    if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) {
      throw new AppError('Coupon usage limit reached', 400);
    }
    const usages = await turfCouponRepository.findUsageByUserAndCoupon(userId, coupon.id);
    if (usages.length >= coupon.per_user_limit) {
      throw new AppError('You have already used this coupon', 400);
    }
    let discount = 0;
    if (coupon.discount_type === 'percentage') {
      discount = Math.round((bookingAmount * parseFloat(coupon.discount_value)) / 100 * 100) / 100;
      if (coupon.max_discount) discount = Math.min(discount, parseFloat(coupon.max_discount));
    } else {
      discount = parseFloat(coupon.discount_value);
    }
    return { coupon, discount };
  }
}

export const turfCouponService = new TurfCouponService();
