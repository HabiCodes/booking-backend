/**
 * Promotion Service — campaign lifecycle, payment orchestration, impression delivery.
 *
 * This is the central service for Phase 5. It coordinates:
 *  1. Campaign creation (validates entity ownership, package)
 *  2. Payment order creation (reuses existing PaymentService)
 *  3. Campaign activation (on payment webhook verification)
 *  4. Impression delivery (atomic, with rank filtering)
 *  5. Click tracking
 *  6. Campaign expiry/cleanup
 *
 * Key invariants:
 *  - Campaigns never exceed max_impressions (atomic UPDATE with WHERE)
 *  - Campaigns only activate after payment verification (never client-side)
 *  - All money values are integer paise
 *  - Config is snapshotted at purchase time
 *  - Organization isolation is enforced server-side
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import type {
  PromotionPackageRow,
  PromotionPackageCreateInput,
  PromotionPackageUpdateInput,
  PromotionCampaignRow,
  PromotionCampaignPublic,
  PromotionCampaignCreateInput,
  PromotionCampaignUpdateInput,
  PromotionCampaignStatus,
  PromotionEntityType,
  PromotionImpressionInput,
  PromotedEntity,
  RankingContext,
  RankedCampaign,
  RankWeights,
  PromotionPlacement,
  AdInventorySlotRow,
  PromotionAttributionCreateInput,
  LedgerReferenceType,
} from '../types';

import { promotionPackageRepository } from '../repositories/promotionPackageRepository';
import { promotionCampaignRepository } from '../repositories/promotionCampaignRepository';
import { promotionImpressionRepository } from '../repositories/promotionImpressionRepository';
import { promotionClickRepository } from '../repositories/promotionClickRepository';
import { adInventorySlotRepository } from '../repositories/adInventorySlotRepository';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { promotionRankingEngine } from './promotionRankingEngine';
import { financialLedgerService } from './financialLedgerService';
import { promotionAttributionRepository } from '../repositories/promotionAttributionRepository';
import type { PaymentOrderCreateInput } from '../types';
import type { PaymentService } from './paymentService';
import { createPaymentService } from './paymentService';

// ── Service Initialization ─────────────────────────────────────────────────────

/**
 * Lazily-initialized PaymentService instance.
 * Initialized on first use to avoid circular dependencies during module load.
 */
let paymentServiceInstance: PaymentService | null = null;

function getPaymentService(): PaymentService {
  if (!paymentServiceInstance) {
    paymentServiceInstance = createPaymentService({
      appId: process.env.CASHFREE_APP_ID || '',
      secretKey: process.env.CASHFREE_SECRET_KEY || '',
      webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || '',
      returnUrl: process.env.CASHFREE_RETURN_URL || '',
      notifyUrl: process.env.CASHFREE_NOTIFY_URL || '',
    });
  }
  return paymentServiceInstance;
}

// Alias for backwards compatibility in code that calls paymentService.createOrder()
export const paymentService = { createOrder: (...args: Parameters<PaymentService['createOrder']>) => getPaymentService().createOrder(...args) };

// ── Package Validation ────────────────────────────────────────────────────────

/**
 * Validate that a target entity exists and is active for promotion.
 * Returns entity info for config snapshot. Organization must own the entity.
 */
async function validateEntityForPromotion(
  entityType: string,
  entityId: number,
  organizationId: number
): Promise<{ name: string; imageUrl: string | null; location: string | null }> {
  if (entityType === 'turf_resource') {
    const resource = await (await import('../repositories/turfResourceRepository')).turfResourceRepository.findById(entityId);
    if (!resource) throw new AppError('Turf resource not found', 404);
    // Verify ownership through venue → organization
    const venue = await (await import('../repositories/turfVenueRepository')).turfVenueRepository.findById(resource.venue_id);
    if (!venue) throw new AppError('Turf venue not found', 404);
    if (venue.organization_id !== organizationId) {
      throw new AppError('You do not own this turf resource', 403);
    }
    return {
      name: `${venue.name} — ${resource.name}`,
      imageUrl: null,
      location: venue.city,
    };
  }

  if (entityType === 'event') {
    const event = await (await import('../repositories/eventRepository')).eventRepository.getEventById(entityId);
    if (!event) throw new AppError('Event not found', 404);
    if (event.organization_id !== organizationId) {
      throw new AppError('You do not own this event', 403);
    }
    return {
      name: event.title,
      imageUrl: (event as any).image_url ?? null,
      location: (event as any).venue ?? null,
    };
  }

  if (entityType === 'venue') {
    const venue = await (await import('../repositories/turfVenueRepository')).turfVenueRepository.findById(entityId);
    if (!venue) throw new AppError('Venue not found', 404);
    if (venue.organization_id !== organizationId) {
      throw new AppError('You do not own this venue', 403);
    }
    return {
      name: venue.name,
      imageUrl: null,
      location: venue.city,
    };
  }

  if (entityType === 'organization') {
    // Organization can only promote itself
    if (entityId !== organizationId) {
      throw new AppError('Cannot promote a different organization', 403);
    }
    const org = await (await import('../repositories/organizationRepository')).organizationRepository.findById(entityId);
    if (!org) throw new AppError('Organization not found', 404);
    return {
      name: org.display_name || org.name,
      imageUrl: org.logo_url ?? null,
      location: org.city ?? null,
    };
  }

  throw new AppError(`Unsupported entity type: ${entityType}`, 400);
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PromotionService {

  // ── Package Management ─────────────────────────────────────────────────────

  async listPackages(query: { isActive?: boolean; isFeatured?: boolean; page?: number; pageSize?: number; search?: string } = {}) {
    return promotionPackageRepository.findAll(query);
  }

  async getPackage(id: number): Promise<PromotionPackageRow | null> {
    return promotionPackageRepository.findById(id);
  }

  async getPackageBySlug(slug: string): Promise<PromotionPackageRow | null> {
    return promotionPackageRepository.findBySlug(slug);
  }

  async listActivePackages(): Promise<PromotionPackageRow[]> {
    return promotionPackageRepository.listActive();
  }

  async createPackage(input: PromotionPackageCreateInput & { created_by_admin_id: number }): Promise<PromotionPackageRow> {
    if (input.price_paise <= 0) throw new AppError('Package price must be positive', 400);
    if (input.duration_days <= 0) throw new AppError('Duration must be positive', 400);
    if (input.max_impressions <= 0) throw new AppError('Max impressions must be positive', 400);
    const pw = input.priority_weight ?? 50;
    if (pw < 1 || pw > 100) {
      throw new AppError('Priority weight must be between 1 and 100', 400);
    }

    // Check slug uniqueness
    const existing = await promotionPackageRepository.findBySlug(
      input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    );
    if (existing) throw new AppError('A package with a similar name already exists', 409);

    return promotionPackageRepository.create(input);
  }

  async updatePackage(id: number, input: any): Promise<PromotionPackageRow | null> {
    if (input.price_paise !== undefined && input.price_paise <= 0) {
      throw new AppError('Package price must be positive', 400);
    }
    // Note: updating a package does NOT affect existing campaigns (config_snapshot preserves history)
    return promotionPackageRepository.update(id, input);
  }

  async deletePackage(id: number): Promise<void> {
    // Check for active campaigns using this package
    const pkg = await promotionPackageRepository.findById(id);
    if (!pkg) throw new AppError('Package not found', 404);

    const activeCampaigns = await promotionCampaignRepository.listActive({ entityType: pkg.eligible_entity_types.join(',') });
    const usingThis = activeCampaigns.filter(c => c.package_id === id);
    if (usingThis.length > 0) {
      throw new AppError('Cannot delete package with active campaigns. Deactivate the package instead.', 409);
    }

    await promotionPackageRepository.softDelete(id);
  }

  // ── Campaign Management ────────────────────────────────────────────────────

  async listCampaigns(organizationId: number, query: { page?: number; pageSize?: number; status?: PromotionCampaignStatus; search?: string } = {}) {
    return promotionCampaignRepository.listByOrganization(organizationId, query);
  }

  async getCampaign(id: number, organizationId: number): Promise<PromotionCampaignRow | null> {
    const campaign = await promotionCampaignRepository.findById(id);
    if (!campaign) return null;
    // Strict organization isolation
    if (campaign.organization_id !== organizationId) {
      throw new AppError('Not found', 404);
    }
    return campaign;
  }

  async getCampaignAdmin(id: number): Promise<PromotionCampaignRow | null> {
    return promotionCampaignRepository.findById(id);
  }

  async createCampaign(
    input: PromotionCampaignCreateInput,
    organizationId: number,
    organizerId: number | null
  ): Promise<PromotionCampaignRow> {
    // 1. Validate package exists and is active
    const pkg = await promotionPackageRepository.findById(input.package_id);
    if (!pkg) throw new AppError('Promotion package not found', 404);
    if (!pkg.is_active) throw new AppError('This promotion package is not available', 400);

    // 2. Validate entity exists, is active, and is owned by this organization
    const entityInfo = await validateEntityForPromotion(input.entity_type, input.entity_id, organizationId);

    // 3. Validate entity_type is allowed for this package
    const allowedTypes = JSON.parse(JSON.stringify(pkg.eligible_entity_types)) as string[];
    if (!allowedTypes.includes(input.entity_type)) {
      throw new AppError(`Entity type "${input.entity_type}" is not eligible for this package`, 400);
    }

    // 4. Validate dates
    const startAt = new Date(input.start_at);
    const endAt = new Date(input.end_at);
    const now = new Date();
    if (startAt >= endAt) throw new AppError('Start time must be before end time', 400);
    if (startAt < now && endAt < now) throw new AppError('Cannot create campaign entirely in the past', 400);

    // 5. Validate date range matches package duration
    const durationMs = (endAt.getTime() - startAt.getTime()) / (1000 * 60 * 60 * 24);
    if (durationMs > pkg.duration_days) {
      throw new AppError(`Campaign duration exceeds package maximum of ${pkg.duration_days} days`, 400);
    }

    // 6. Build config snapshot (immutable)
    const configSnapshot = {
      package_name: pkg.name,
      package_slug: pkg.slug,
      price_paise: pkg.price_paise,
      currency: pkg.currency,
      duration_days: pkg.duration_days,
      max_impressions: pkg.max_impressions,
      priority_weight: pkg.priority_weight,
      eligible_categories: pkg.eligible_categories,
      eligible_entity_types: pkg.eligible_entity_types,
      eligible_placements: pkg.eligible_placements,
      metadata: pkg.metadata,
    };

    // 7. Create campaign in PENDING_PAYMENT status
    const campaign = await promotionCampaignRepository.create({
      organization_id: organizationId,
      package_id: pkg.id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      entity_name: entityInfo.name,
      entity_image_url: input.entity_image_url ?? entityInfo.imageUrl,
      entity_location: input.entity_location ?? entityInfo.location,
      start_at: input.start_at,
      end_at: input.end_at,
      max_impressions: pkg.max_impressions,
      priority_weight: pkg.priority_weight,
      config_snapshot: configSnapshot,
      created_by_organizer_id: organizerId ?? undefined,
    });

    logger.info('Promotion campaign created (pending payment)', {
      campaignId: campaign.id,
      organizationId,
      packageId: pkg.id,
    });

    return campaign;
  }

  // ── Payment & Activation ───────────────────────────────────────────────────

  /**
   * Create a payment order for a campaign.
   * Returns the campaign + payment session ID for the frontend.
   */
  async createCampaignPayment(
    campaignId: number,
    organizationId: number,
    customerEmail: string,
    customerPhone: string,
    customerName: string
  ): Promise<{ campaign: PromotionCampaignRow; paymentSessionId: string; orderId: string }> {
    const campaign = await promotionCampaignRepository.findById(campaignId);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.organization_id !== organizationId) throw new AppError('Not found', 404);

    if (campaign.status !== 'PENDING_PAYMENT') {
      throw new AppError(`Campaign is not pending payment (current: ${campaign.status})`, 400);
    }

    // Use config_snapshot price (immutable, not the current package price)
    const pricePaise = Number(campaign.config_snapshot.price_paise);
    if (!pricePaise || pricePaise <= 0) throw new AppError('Invalid campaign price', 500);

    // Generate unique order ID
    const orderId = `PROMO_${campaign.id}_${Date.now()}`;

    // Idempotency key — prevents duplicate payment orders
    const idempotencyKey = `promotion_campaign_${campaign.id}`;

    // Reuse existing PaymentService
    const paymentResult = await paymentService.createOrder({
      booking_id: 0,
      order_id: orderId,
      orderId,
      organization_id: organizationId,
      event_id: null,
      amount: pricePaise,
      currency: 'INR',
      idempotency_key: idempotencyKey,
      metadata: {
        promotion_campaign_id: campaign.id,
        entity_type: campaign.entity_type,
        entity_id: campaign.entity_id,
        package_id: campaign.package_id,
        campaign_type: 'promotion',
      },
      customerEmail,
      customerPhone,
      customerName,
    });

    // Link payment order to campaign
    await promotionCampaignRepository.update(campaign.id, {
      status: 'PENDING_PAYMENT',
      payment_order_id: paymentResult.order.order_id,
    });

    logger.info('Campaign payment order created', {
      campaignId,
      orderId,
      amount: pricePaise,
    });

    return {
      campaign,
      paymentSessionId: paymentResult.paymentSessionId,
      orderId: paymentResult.order.order_id,
    };
  }

  /**
   * Activate a campaign after successful payment.
   * Called by the webhook handler — never by the client.
   */
  async activateCampaign(campaignId: number): Promise<PromotionCampaignRow> {
    const campaign = await promotionCampaignRepository.findById(campaignId);
    if (!campaign) throw new AppError('Campaign not found', 404);

    if (campaign.status !== 'PENDING_PAYMENT') {
      // Already activated or in terminal state — return as-is (idempotent)
      if (['ACTIVE', 'EXPIRED', 'CANCELLED', 'DEPLETED', 'REJECTED', 'REFUNDED'].includes(campaign.status)) {
        logger.info('Campaign activation skipped — already in terminal state', { campaignId, status: campaign.status });
        return campaign;
      }
      throw new AppError(`Cannot activate campaign in status: ${campaign.status}`, 400);
    }

    // Verify payment was successful
    if (!campaign.payment_order_id) {
      throw new AppError('Campaign has no payment order', 400);
    }

    const paymentOrder = await paymentOrderRepository.findByOrderId(campaign.payment_order_id);
    if (!paymentOrder) throw new AppError('Payment order not found', 404);
    if (paymentOrder.status !== 'COMPLETED') {
      throw new AppError(`Payment not completed (status: ${paymentOrder.status})`, 400);
    }

    // Activate
    const activated = await promotionCampaignRepository.activate(
      campaignId,
      campaign.payment_order_id,
      campaign.config_snapshot.price_paise as number
    );

    if (!activated) throw new AppError('Failed to activate campaign', 500);

    // Post revenue to ledger (idempotent via unique constraint)
    await financialLedgerService.postPromotionRevenue({
      organization_id: campaign.organization_id,
      amount_paise: campaign.config_snapshot.price_paise as number,
      reference_type: 'promotion_campaign',
      reference_id: campaignId,
      payment_order_id: paymentOrder.id,
      config_snapshot: {
        package_name: campaign.config_snapshot.package_name,
        entity_type: campaign.entity_type,
        entity_name: campaign.entity_name,
      },
      description: `Promotion payment: ${campaign.config_snapshot.package_name} for ${campaign.entity_name}`,
    });

    logger.info('Campaign activated', { campaignId });
    return activated;
  }

  // ── Impression Delivery ────────────────────────────────────────────────────

  /**
   * Deliver impressions for eligible campaigns in a given context.
   *
   * Steps:
   *  1. Check inventory slot limit
   *  2. Filter eligible campaigns
   *  3. Rank campaigns
   *  4. Atomic impression delivery (increment counter + insert impression record)
   *  5. Return sponsored entities
   */
  async deliverSponsoredResults(context: {
    placement: PromotionPlacement;
    category?: string;
    locationKey?: string;
    entityType?: string;
    limit: number;
    userSessionId?: string | null;
    requestId?: string | null;
  }): Promise<{ sponsored: PromotedEntity[]; total: number }> {
    const { placement, category, locationKey, entityType, limit, userSessionId, requestId } = context;

    // 1. Check inventory slot limit
    const slotLimit = await this._getSlotLimit(locationKey || 'global', category || 'all', placement);
    const slotCount = await this._countActiveCampaignsForSlot(locationKey || 'global', category || 'all', placement);
    if (slotCount >= slotLimit) {
      return { sponsored: [], total: 0 };
    }
    const availableSlots = Math.min(limit, slotLimit - slotCount);
    if (availableSlots <= 0) {
      return { sponsored: [], total: 0 };
    }

    // 2. Get eligible campaigns
    const eligibleCampaigns = await promotionCampaignRepository.listEligibleForRanking({
      placement,
      category,
      locationKey,
      entityType,
    });

    if (eligibleCampaigns.length === 0) {
      return { sponsored: [], total: 0 };
    }

    // 3. Rank campaigns
    const weights = await this._getRankWeights();
    const ranked = promotionRankingEngine.rank(eligibleCampaigns, { placement, category, location_key: locationKey, entity_type: entityType as PromotionEntityType | undefined, limit: availableSlots }, weights);

    if (ranked.length === 0) {
      return { sponsored: [], total: 0 };
    }

    // 4. Atomically deliver impressions
    const sponsored: PromotedEntity[] = [];
    for (const rankedCampaign of ranked) {
      // Atomic check-and-increment: UPDATE ... WHERE impressions_delivered < max_impressions
      const updated = await promotionCampaignRepository.incrementImpressions(rankedCampaign.campaign_id, 1);
      if (!updated) {
        // Campaign exhausted between rank and delivery — skip
        logger.warn('Campaign exhausted during impression delivery', { campaignId: rankedCampaign.campaign_id });
        continue;
      }

      // Verify the increment actually happened (atomicity check)
      if (updated.impressions_delivered > updated.max_impressions) {
        logger.error('Impression count exceeded limit after atomic increment', {
          campaignId: rankedCampaign.campaign_id,
          delivered: updated.impressions_delivered,
          max: updated.max_impressions,
        });
        // Roll back (should not happen with proper WHERE clause)
        await promotionCampaignRepository.incrementImpressions(rankedCampaign.campaign_id, -1);
        continue;
      }

      // Record impression
      await promotionImpressionRepository.create({
        campaign_id: rankedCampaign.campaign_id,
        placement,
        position: rankedCampaign.position,
        ranking_score: rankedCampaign.ranking_score,
        user_session_id: userSessionId ?? null,
        request_id: requestId ?? null,
        device_type: 'unknown',
      });

      sponsored.push({
        campaign_id: rankedCampaign.campaign_id,
        entity_type: rankedCampaign.entity_type,
        entity_id: rankedCampaign.entity_id,
        entity_name: rankedCampaign.entity_name,
        entity_image_url: rankedCampaign.entity_image_url,
        entity_location: rankedCampaign.entity_location,
        placement,
        position: rankedCampaign.position,
        ranking_score: rankedCampaign.ranking_score,
        priority_weight: rankedCampaign.priority_weight,
        sponsored: true,
      });
    }

    return { sponsored, total: eligibleCampaigns.length };
  }

  // ── Click Tracking ─────────────────────────────────────────────────────────

  async trackClick(campaignId: number, impressionId?: number, userSessionId?: string): Promise<void> {
    await promotionClickRepository.create({
      campaign_id: campaignId,
      impression_id: impressionId ?? null,
      user_session_id: userSessionId ?? null,
    });
    await promotionCampaignRepository.incrementClicks(campaignId);
  }

  // ── Attribution ────────────────────────────────────────────────────────────

  /**
   * Attribute a booking to a campaign.
   * Called when a booking is confirmed — checks if any campaign interaction
   * (click or view) happened within the attribution window.
   */
  async attributeBooking(
    userId: number,
    bookingId: number,
    bookingAmountPaise: number,
    interactionWindowHours: { click: number; view: number } = { click: 168, view: 24 }
  ): Promise<void> {
    // Find the most recent click from this user within the window
    const { promotionClickRepository } = await import('../repositories/promotionClickRepository');
    const { promotionImpressionRepository } = await import('../repositories/promotionImpressionRepository');

    // Get user's sessions with impressions within the attribution window
    const viewThreshold = new Date(Date.now() - interactionWindowHours.view * 60 * 60 * 1000).toISOString();
    const clickThreshold = new Date(Date.now() - interactionWindowHours.click * 60 * 60 * 1000).toISOString();

    // Check for click-through attribution first (higher priority)
    const recentClicks = await promotionClickRepository.findByUserSince(String(userId), new Date(clickThreshold));

    // For now, check the most recent campaign interaction via impression + click
    const { rows: impressionRows } = await (await import('../db/pool')).getPool().query(
      `SELECT pi.campaign_id, pi.id as impression_id, pi.delivered_at,
              pc.clicked_at, 'view' as attribution_type
       FROM promotion_impressions pi
       LEFT JOIN promotion_clicks pc ON pc.impression_id = pi.id AND pc.user_session_id = pi.user_session_id
       WHERE pi.user_session_id = (
         SELECT user_session_id FROM promotion_impressions
         WHERE delivered_at >= $1
         LIMIT 1
       )
       AND pi.delivered_at >= $1
       AND pi.delivered_at < $2
       ORDER BY pi.delivered_at DESC
       LIMIT 1`,
      [viewThreshold, new Date().toISOString()]
    );

    if (impressionRows.length === 0) return; // No attribution possible

    const row = impressionRows[0] as { campaign_id: number; impression_id: number; delivered_at: string; attribution_type: string };
    const attributionType = row.delivered_at ? 'view' : 'click';
    const windowHours = attributionType === 'click' ? interactionWindowHours.click : interactionWindowHours.view;

    // Check not already attributed
    const { promotionAttributionRepository } = await import('../repositories/promotionAttributionRepository');
    const alreadyAttributed = await promotionAttributionRepository.exists(row.campaign_id, bookingId);
    if (alreadyAttributed) return;

    await promotionAttributionRepository.create({
      campaign_id: row.campaign_id,
      booking_id: bookingId,
      attribution_type: attributionType as 'click' | 'view',
      attribution_window_hours: windowHours,
      interaction_at: row.delivered_at,
      booking_amount_paise: bookingAmountPaise,
    });

    logger.info('Booking attributed to campaign', { campaignId: row.campaign_id, bookingId, attributionType });
  }

  // ── Campaign Actions ───────────────────────────────────────────────────────

  async cancelCampaign(campaignId: number, organizationId: number): Promise<PromotionCampaignRow> {
    const campaign = await promotionCampaignRepository.findById(campaignId);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.organization_id !== organizationId) throw new AppError('Not found', 404);

    const activeStatuses = ['ACTIVE', 'PAUSED', 'PENDING_PAYMENT'];
    if (!activeStatuses.includes(campaign.status)) {
      throw new AppError(`Cannot cancel campaign in status: ${campaign.status}`, 400);
    }

    const cancelled = await promotionCampaignRepository.cancel(campaignId);
    if (!cancelled) throw new AppError('Failed to cancel campaign', 500);

    logger.info('Campaign cancelled', { campaignId });
    return cancelled;
  }

  // ── Admin Campaign Actions ─────────────────────────────────────────────────

  async listAllCampaignsAdmin(query: { page?: number; pageSize?: number; status?: string; organizationId?: number } = {}) {
    // Admin can see all campaigns — implement a repository method for admin listing
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const where: string[] = ['pc.deleted_at IS NULL'];
    const params: unknown[] = [];
    let idx = 1;
    if (query.status) { where.push(`pc.status = $${idx++}`); params.push(query.status); }
    if (query.organizationId) { where.push(`pc.organization_id = $${idx++}`); params.push(query.organizationId); }
    const whereStr = `WHERE ${where.join(' AND ')}`;
    const { rows: countRows } = await (await import('../db/pool')).getPool().query(
      `SELECT COUNT(*) as total FROM promotion_campaigns pc ${whereStr}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await (await import('../db/pool')).getPool().query(
      `SELECT pc.*, pp.name as package_name, o.name as org_name
       FROM promotion_campaigns pc
       JOIN promotion_packages pp ON pp.id = pc.package_id
       JOIN organizations o ON o.id = pc.organization_id
       ${whereStr}
       ORDER BY pc.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return {
      items: rows as PromotionCampaignPublic[],
      total, page, pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    };
  }

  async approveCampaign(id: number): Promise<PromotionCampaignRow | null> {
    const campaign = await promotionCampaignRepository.findById(id);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.status !== 'PENDING_PAYMENT') {
      throw new AppError(`Cannot approve campaign in status: ${campaign.status}`, 400);
    }
    const { rows } = await (await import('../db/pool')).getPool().query(
      `UPDATE promotion_campaigns SET status = 'ACTIVE', approved_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async rejectCampaign(id: number, reason: string): Promise<PromotionCampaignRow | null> {
    const campaign = await promotionCampaignRepository.findById(id);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.status !== 'PENDING_PAYMENT') {
      throw new AppError(`Cannot reject campaign in status: ${campaign.status}`, 400);
    }
    const { rows } = await (await import('../db/pool')).getPool().query(
      `UPDATE promotion_campaigns SET status = 'REJECTED', rejection_reason = $2 WHERE id = $1 RETURNING *`,
      [id, reason]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async pauseCampaign(id: number, reason?: string): Promise<PromotionCampaignRow | null> {
    const campaign = await promotionCampaignRepository.findById(id);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.status !== 'ACTIVE') {
      throw new AppError(`Cannot pause campaign in status: ${campaign.status}`, 400);
    }
    const { rows } = await (await import('../db/pool')).getPool().query(
      `UPDATE promotion_campaigns SET status = 'PAUSED', paused_at = NOW(), paused_reason = $2 WHERE id = $1 RETURNING *`,
      [id, reason ?? null]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  async resumeCampaign(id: number): Promise<PromotionCampaignRow | null> {
    const campaign = await promotionCampaignRepository.findById(id);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.status !== 'PAUSED') {
      throw new AppError(`Cannot resume campaign in status: ${campaign.status}`, 400);
    }
    const { rows } = await (await import('../db/pool')).getPool().query(
      `UPDATE promotion_campaigns SET status = 'ACTIVE', paused_at = NULL, paused_reason = NULL WHERE id = $1 RETURNING *`,
      [id]
    );
    return (rows as unknown as PromotionCampaignRow[])[0] || null;
  }

  // ── Ranking ────────────────────────────────────────────────────────────────

  async getRankedCampaigns(context: {
    placement: PromotionPlacement;
    category?: string;
    locationKey?: string;
    entityType?: string;
    limit?: number;
  }): Promise<RankedCampaign[]> {
    const campaigns = await promotionCampaignRepository.listEligibleForRanking(context);
    const weights = await this._getRankWeights();
    return promotionRankingEngine.rank(campaigns, { ...context, limit: context.limit || 10 }, weights);
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  async getCampaignAnalytics(campaignId: number, organizationId: number) {
    const campaign = await promotionCampaignRepository.findById(campaignId);
    if (!campaign) throw new AppError('Campaign not found', 404);
    if (campaign.organization_id !== organizationId) throw new AppError('Not found', 404);

    const impressions = campaign.impressions_delivered;
    const uniqueImpressions = await promotionImpressionRepository.countUniqueByCampaign(campaignId);
    const clicks = campaign.clicks;
    const uniqueClicks = await promotionClickRepository.countUniqueByCampaign(campaignId);
    const attributedBookings = await promotionAttributionRepository.countByCampaign(campaignId);
    const attributedRevenue = await promotionAttributionRepository.getRevenueByCampaign(campaignId);

    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    const conversionRate = clicks > 0 ? (attributedBookings / clicks) * 100 : 0;
    const roi = attributedRevenue > 0 ? ((attributedRevenue - campaign.total_spend_paise) / campaign.total_spend_paise) * 100 : 0;
    const deliveryRate = campaign.max_impressions > 0 ? (impressions / campaign.max_impressions) * 100 : 0;

    return {
      campaign_id: campaignId,
      campaign_name: campaign.entity_name,
      status: campaign.status,
      start_at: campaign.start_at,
      end_at: campaign.end_at,
      impressions,
      unique_impressions: uniqueImpressions,
      clicks,
      unique_clicks: uniqueClicks,
      ctr: Math.round(ctr * 100) / 100,
      attributed_bookings: attributedBookings,
      attributed_revenue_paise: attributedRevenue,
      conversion_rate: Math.round(conversionRate * 100) / 100,
      spend_paise: campaign.total_spend_paise,
      roi: Math.round(roi * 100) / 100,
      remaining_impressions: Math.max(0, campaign.max_impressions - impressions),
      delivery_rate: Math.round(deliveryRate * 100) / 100,
      max_impressions: campaign.max_impressions,
      impressions_delivered: impressions,
    };
  }

  async getPlatformAnalytics() {
    const pool = (await import('../db/pool')).getPool();

    const { rows: summaryRows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('ACTIVE','PAUSED')) as active_campaigns,
         COUNT(*) as total_campaigns,
         SUM(impressions_delivered) as total_impressions,
         SUM(clicks) as total_clicks,
         SUM(total_spend_paise) as total_spend_paise
       FROM promotion_campaigns WHERE deleted_at IS NULL`
    );
    const summary = (summaryRows as any[])[0] || {};

    const { rows: attrRows } = await pool.query(
      `SELECT COUNT(*) as total_bookings, SUM(booking_amount_paise) as total_revenue
       FROM promotion_attributions`
    );
    const attr = (attrRows as any[])[0] || {};

    const totalImpressions = Number(summary.total_impressions) || 0;
    const totalClicks = Number(summary.total_clicks) || 0;
    const totalAttributedRevenue = Number(attr.total_revenue) || 0;
    const totalSpend = Number(summary.total_spend_paise) || 0;
    const totalAttributedBookings = Number(attr.total_bookings) || 0;

    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const conversionRate = totalClicks > 0 ? (totalAttributedBookings / totalClicks) * 100 : 0;
    const roi = totalSpend > 0 ? ((totalAttributedRevenue - totalSpend) / totalSpend) * 100 : 0;

    // By placement
    const { rows: placementRows } = await pool.query(
      `SELECT pi.placement, COUNT(*) as impressions, COUNT(DISTINCT pi.user_session_id) as unique_impressions, COUNT(pc.id) as clicks
       FROM promotion_impressions pi
       LEFT JOIN promotion_clicks pc ON pc.campaign_id = pi.campaign_id
       GROUP BY pi.placement`
    );

    // By category (from campaign config_snapshot)
    const { rows: categoryRows } = await pool.query(
      `SELECT category, SUM(impressions) as impressions, SUM(clicks) as clicks
       FROM (
         SELECT jsonb_array_elements_text(pc.config_snapshot->'eligible_categories') as category,
                pc.impressions_delivered as impressions, pc.clicks as clicks
         FROM promotion_campaigns pc WHERE pc.deleted_at IS NULL AND pc.status = 'ACTIVE'
       ) sub GROUP BY category`
    );

    // By location
    const { rows: locationRows } = await pool.query(
      `SELECT entity_location, SUM(impressions_delivered) as impressions, SUM(clicks) as clicks
       FROM promotion_campaigns WHERE deleted_at IS NULL AND status = 'ACTIVE' AND entity_location IS NOT NULL
       GROUP BY entity_location`
    );

    // Daily performance (last 30 days)
    const { rows: dailyRows } = await pool.query(
      `SELECT
         pi.delivered_at::date as date,
         COUNT(*) as impressions,
         COUNT(DISTINCT pi.user_session_id) as unique_impressions,
         (SELECT COUNT(*) FROM promotion_clicks pc2 WHERE pc2.campaign_id = ANY(ARRAY(SELECT DISTINCT pc3.id FROM promotion_campaigns pc3)) AND pc2.clicked_at::date = pi.delivered_at::date) as clicks
       FROM promotion_impressions pi
       WHERE pi.delivered_at >= NOW() - INTERVAL '30 days'
       GROUP BY pi.delivered_at::date
       ORDER BY pi.delivered_at::date ASC`
    );

    return {
      total_campaigns: Number(summary.total_campaigns) || 0,
      active_campaigns: Number(summary.active_campaigns) || 0,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      total_attributed_bookings: totalAttributedBookings,
      total_attributed_revenue_paise: totalAttributedRevenue,
      total_spend_paise: totalSpend,
      avg_ctr: Math.round(ctr * 100) / 100,
      avg_conversion_rate: Math.round(conversionRate * 100) / 100,
      avg_roi: Math.round(roi * 100) / 100,
      by_placement: placementRows.map((r: any) => ({
        placement: r.placement,
        impressions: Number(r.impressions),
        unique_impressions: Number(r.unique_impressions),
        clicks: Number(r.clicks),
        ctr: Number(r.impressions) > 0 ? Math.round((Number(r.clicks) / Number(r.impressions)) * 10000) / 100 : 0,
      })),
      by_category: categoryRows.map((r: any) => ({
        category: r.category,
        impressions: Number(r.impressions),
        unique_impressions: Number(r.impressions), // proxy
        clicks: Number(r.clicks),
        attributed_bookings: 0,
      })),
      by_location: locationRows.map((r: any) => ({
        location_key: r.entity_location,
        impressions: Number(r.impressions),
        unique_impressions: Number(r.impressions),
        clicks: Number(r.clicks),
        attributed_bookings: 0,
      })),
      daily: dailyRows.map((r: any) => ({
        date: r.date,
        impressions: Number(r.impressions),
        unique_impressions: Number(r.unique_impressions),
        clicks: Number(r.clicks),
        attributed_bookings: 0,
        attributed_revenue_paise: 0,
        spend_paise: 0,
      })),
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  private async _getSlotLimit(locationKey: string, category: string, placement: string): Promise<number> {
    const slot = await adInventorySlotRepository.findByKey(locationKey, category, placement);
    if (slot) return slot.max_slots;

    // Try global category default
    const globalSlot = await adInventorySlotRepository.findByKey('global', category, placement);
    if (globalSlot) return globalSlot.max_slots;

    // Try global all-category default
    const allSlot = await adInventorySlotRepository.findByKey('global', 'all', placement);
    if (allSlot) return allSlot.max_slots;

    // Default: 3 sponsored slots per placement
    return 3;
  }

  private async _countActiveCampaignsForSlot(locationKey: string, category: string, placement: string): Promise<number> {
    // Count campaigns currently serving in this slot context
    const eligible = await promotionCampaignRepository.listEligibleForRanking({ placement, category, locationKey });
    return eligible.length;
  }

  private async _getRankWeights(): Promise<RankWeights> {
    const pool = (await import('../db/pool')).getPool();
    const { rows } = await pool.query('SELECT w1_priority, w2_relevance, w3_deficit FROM promotion_rank_weights WHERE id = 1 LIMIT 1');
    if (rows.length > 0) {
      const r = rows[0] as { w1_priority: number; w2_relevance: number; w3_deficit: number };
      return { w1_priority: r.w1_priority, w2_relevance: r.w2_relevance, w3_deficit: r.w3_deficit };
    }
    return { w1_priority: 50, w2_relevance: 30, w3_deficit: 20 };
  }
}

export const promotionService = new PromotionService();
