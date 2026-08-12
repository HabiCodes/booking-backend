/**
 * Promotion Click repository.
 */

import { getPool } from '../db/pool';
import type { PromotionClickRow } from '../types';

export class PromotionClickRepository {
  async create(input: {
    campaign_id: number;
    impression_id?: number | null;
    user_session_id?: string | null;
    ip_hash?: string | null;
    user_agent?: string | null;
    device_type?: string;
  }): Promise<PromotionClickRow> {
    const { rows } = await getPool().query(
      `INSERT INTO promotion_clicks
       (campaign_id, impression_id, user_session_id, ip_hash, user_agent, device_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        input.campaign_id,
        input.impression_id ?? null,
        input.user_session_id ?? null,
        input.ip_hash ?? null,
        input.user_agent ?? null,
        input.device_type ?? 'unknown',
      ]
    );
    return (rows as unknown as PromotionClickRow[])[0];
  }

  async countByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COUNT(*) as total FROM promotion_clicks WHERE campaign_id = $1',
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async countUniqueByCampaign(campaignId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(DISTINCT user_session_id) as total
       FROM promotion_clicks
       WHERE campaign_id = $1 AND user_session_id IS NOT NULL`,
      [campaignId]
    );
    return Number((rows as Array<{ total: number | string }>)[0]?.total ?? 0);
  }

  async findByUserSince(userSessionId: string, since: Date): Promise<PromotionClickRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM promotion_clicks WHERE user_session_id = $1 AND clicked_at >= $2 ORDER BY clicked_at DESC',
      [userSessionId, since.toISOString()]
    );
    return rows as unknown as PromotionClickRow[];
  }
}

export const promotionClickRepository = new PromotionClickRepository();
