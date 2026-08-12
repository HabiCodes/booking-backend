/**
 * Promotion Ranking Engine — pure function for ranking eligible campaigns.
 *
 * Formula:
 *   rankScore = (bidWeight × w1/100) + (relevanceScore × w2/100) + (impressionDeficit × w3/100)
 *
 *   bidWeight        = campaign.priority_weight / 100   (0–1)
 *   relevanceScore   = computed from entity_type, category, placement, location match (0–1)
 *   impressionDeficit = (max_impressions - impressions_delivered) / max_impressions (0–1)
 *
 *   w1 + w2 + w3 = 100 (configurable by admin, defaults 50/30/20)
 *
 * This is a pure service: no DB access, no side effects. Easy to test and cache.
 */

import type {
  PromotionCampaignRow,
  RankingContext,
  RankedCampaign,
  RankWeights,
  PromotionPlacement,
} from '../types';

export class PromotionRankingEngine {
  /**
   * Rank eligible campaigns for a given context.
   *
   * @param campaigns — pre-filtered campaigns (active, in schedule, not exhausted, category/placement match)
   * @param context — placement, optional category/location, entity_type, limit
   * @param weights — ranking weights (defaults to 50/30/20)
   * @returns ranked campaigns sorted by descending score
   */
  rank(campaigns: PromotionCampaignRow[], context: RankingContext, weights: RankWeights = { w1_priority: 50, w2_relevance: 30, w3_deficit: 20 }): RankedCampaign[] {
    const w1 = weights.w1_priority / 100;
    const w2 = weights.w2_relevance / 100;
    const w3 = weights.w3_deficit / 100;

    const eligibleCategories = this._parseJsonbArray<string>(context.category ? [context.category] : []);
    const targetPlacements: string[] = context.placement ? [context.placement] : [];

    let ranked = campaigns.map((campaign) => {
      const bidWeight = campaign.priority_weight / 100;
      const relevanceScore = this._computeRelevance(campaign, context, eligibleCategories, targetPlacements);
      const impressionDeficit = campaign.max_impressions > 0
        ? Math.max(0, (campaign.max_impressions - campaign.impressions_delivered) / campaign.max_impressions)
        : 0;

      const score = (bidWeight * w1) + (relevanceScore * w2) + (impressionDeficit * w3);

      return {
        campaign_id: campaign.id,
        entity_type: campaign.entity_type,
        entity_id: campaign.entity_id,
        entity_name: campaign.entity_name,
        entity_image_url: campaign.entity_image_url,
        entity_location: campaign.entity_location,
        placement: context.placement as PromotionPlacement,
        position: 0,
        ranking_score: Math.round(score * 10000) / 10000,
        priority_weight: campaign.priority_weight,
        impressions_delivered: campaign.impressions_delivered,
        max_impressions: campaign.max_impressions,
        relevance_score: Math.round(relevanceScore * 10000) / 10000,
        impression_deficit: Math.round(impressionDeficit * 10000) / 10000,
        bid_weight: Math.round(bidWeight * 10000) / 10000,
      };
    });

    // Sort by descending score, then ascending impressions_delivered (deficit tie-breaker)
    ranked.sort((a, b) => {
      if (b.ranking_score !== a.ranking_score) return b.ranking_score - a.ranking_score;
      return a.impressions_delivered - b.impressions_delivered;
    });

    // Assign positions (1-indexed) and respect the limit
    return ranked.slice(0, context.limit).map((r, i) => ({ ...r, position: i + 1 }));
  }

  /**
   * Compute relevance score (0–1) based on how well the campaign matches the context.
   *
   * Components:
   *   - Entity type match: 0.30
   *   - Category match: 0.30
   *   - Placement match: 0.20
   *   - Location match: 0.20
   */
  private _computeRelevance(
    campaign: PromotionCampaignRow,
    context: RankingContext,
    queryCategories: string[],
    queryPlacements: string[]
  ): number {
    const eligibleCategories = this._parseJsonbArray<string>(campaign.config_snapshot.eligible_categories as string[] || []);
    const eligiblePlacements = this._parseJsonbArray<string>(campaign.config_snapshot.eligible_placements as string[] || []);

    let score = 0;

    // Entity type match (0.30)
    if (context.entity_type && campaign.entity_type === context.entity_type) {
      score += 0.30;
    }

    // Category match (0.30) — at least one category overlap
    if (queryCategories.length > 0 && eligibleCategories.length > 0) {
      const overlap = queryCategories.some(c => eligibleCategories.includes(c.toLowerCase()));
      if (overlap) score += 0.30;
    }

    // Placement match (0.20)
    if (queryPlacements.length > 0 && eligiblePlacements.length > 0) {
      const overlap = queryPlacements.some(p => eligiblePlacements.includes(p));
      if (overlap) score += 0.20;
    }

    // Location match (0.20) — entity_location contains the location_key
    if (context.location_key && campaign.entity_location) {
      if (campaign.entity_location.toLowerCase().includes(context.location_key.toLowerCase())) {
        score += 0.20;
      }
    }

    return Math.min(score, 1.0);
  }

  private _parseJsonbArray<T>(value: unknown): T[] {
    if (!value) return [];
    if (Array.isArray(value)) return value as T[];
    if (typeof value === 'string') {
      try { return JSON.parse(value) as T[]; } catch { return []; }
    }
    return [];
  }
}

export const promotionRankingEngine = new PromotionRankingEngine();
