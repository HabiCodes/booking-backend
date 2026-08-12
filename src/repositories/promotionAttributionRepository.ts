/**
 * Promotion Attribution repository.
 *
 * Links campaigns to bookings with configurable attribution windows.
 */

import { getPool } from '../db/pool';
import type { PromotionAttributionRow, PromotionAttributionCreateInput } from '../types';

export class PromotionAttributionRepository {
  async create(input: PromotionAttributionCreateInput): Promise<PromotionAttributionRow> {
    const { rows } = await getPool().query(
      `INSERT INTO promotion_attributions
       (campaign_id, booking_id, attribution_type, attribution_window_hours,
        interaction_at, booking_amount_paise, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.campaign_id,
        input.booking_id,
        input.attribution_type,
        input.attribution_window_hours,
        input.interaction_at,
        input.booking_amount_paise,
        JSON.stringify(input.metadata || {}),
      ]
    );
    return (rows as unknown as PromotionAttributionRow[])[0];
  }

  async findByCampaign(campaignId: number): Promise<PromotionAttributionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_attributions WHERE campaign_id = $1 ORDER BY attributed_at DESC',
      [campaignId]
    );
    return rows as unknown as PromotionAttributionRow[];
  }

  async findByBooking(bookingId: number): Promise<PromotionAttributionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_attributions WHERE booking_id = $1 LIMIT 1',
      [bookingId]
    );
    return (rows as unknown as PromotionAttributionRow[])[0] || null;
  }

  async exists(campaignId: number, bookingId: number): Promise<boolean> {
    const { rows } = await getPool().query(
      'SELECT 1 FROM promotion_attributions WHERE campaign_id = $1 AND booking_id = $2 LIMIT 1',
      [campaignId, bookingId]
    );
    return rows.length > 0;
  }

  async countByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as total FROM promotion_attributions WHERE campaign_id = $1',
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async getRevenueByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT SUM(booking_amount_paise) as total FROM promotion_attributions WHERE campaign_id = $1',
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }
}

export const promotionAttributionRepository = new PromotionAttributionRepository();
