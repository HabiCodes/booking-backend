/**
 * Promotion Impression repository.
 *
 * Idempotency is enforced at the DB level via a unique constraint on
 * (campaign_id, request_id, placement) WHERE request_id IS NOT NULL.
 * For organic loads without a request_id, callers should handle dedup via
 * user_session_id + time window before calling create().
 */

import { getPool } from '../db/pool';
import type { PromotionImpressionRow, PromotionImpressionInput, PromotionPlacement } from '../types';

export class PromotionImpressionRepository {
  async create(input: PromotionImpressionInput): Promise<PromotionImpressionRow> {
    const { rows } = await getPool().query(
      `INSERT INTO promotion_impressions
       (campaign_id, placement, position, ranking_score, user_session_id, request_id,
        ip_hash, user_agent, device_type, location_context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        input.campaign_id,
        input.placement,
        input.position,
        input.ranking_score,
        input.user_session_id ?? null,
        input.request_id ?? null,
        input.ip_hash ?? null,
        input.user_agent ?? null,
        input.device_type ?? 'unknown',
        JSON.stringify(input.location_context || {}),
      ]
    );
    return (rows as unknown as PromotionImpressionRow[])[0];
  }

  async findById(id: number): Promise<PromotionImpressionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_impressions WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as PromotionImpressionRow[])[0] || null;
  }

  async countByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as total FROM promotion_impressions WHERE campaign_id = $1',
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async countUniqueByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(DISTINCT user_session_id) as total
       FROM promotion_impressions
       WHERE campaign_id = $1 AND user_session_id IS NOT NULL`,
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async countByCampaignPlacementDate(
    campaignId: number, placement: PromotionPlacement, date: string
  ): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as total FROM promotion_impressions
       WHERE campaign_id = $1 AND placement = $2 AND delivered_at::date = $3`,
      [campaignId, placement, date]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async getDailyAggregates(campaignId: number, fromDate: string, toDate: string): Promise<Array<{
    date: string;
    impressions: number;
    unique_impressions: number;
    clicks: number;
  }>> {
    const { rows } = await getPool().query(
      `SELECT
         pi.delivered_at::date as date,
         COUNT(*) as impressions,
         COUNT(DISTINCT pi.user_session_id) as unique_impressions,
         (SELECT COUNT(*) FROM promotion_clicks pc
          WHERE pc.campaign_id = $1 AND pc.clicked_at::date = pi.delivered_at::date) as clicks
       FROM promotion_impressions pi
       WHERE pi.campaign_id = $1 AND pi.delivered_at::date >= $2 AND pi.delivered_at::date <= $3
       GROUP BY pi.delivered_at::date
       ORDER BY pi.delivered_at::date ASC`,
      [campaignId, fromDate, toDate]
    );
    return rows as Array<{ date: string; impressions: number; unique_impressions: number; clicks: number }>;
  }

  async getPlacementAggregates(campaignId: number): Promise<Array<{
    placement: string;
    impressions: number;
    unique_impressions: number;
  }>> {
    const { rows } = await getPool().query(
      `SELECT
         placement,
         COUNT(*) as impressions,
         COUNT(DISTINCT user_session_id) as unique_impressions
       FROM promotion_impressions
       WHERE campaign_id = $1 AND user_session_id IS NOT NULL
       GROUP BY placement`,
      [campaignId]
    );
    return rows as Array<{ placement: string; impressions: number; unique_impressions: number }>;
  }
}

export const promotionImpressionRepository = new PromotionImpressionRepository();
