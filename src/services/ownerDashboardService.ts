/**
 * OwnerDashboardService — aggregated revenue and business-growth analytics.
 *
 * All heavy lifting is done in PostgreSQL via CTEs and window functions.
 * Results are returned as typed DTOs — never raw rows.
 *
 * Authorization is the caller's responsibility (organizerAuthMiddleware + org scoping).
 *
 * CROSS-DOMAIN: This service now handles turf, event, and movie analytics.
 * Financial calculations use financial_configs via FinancialCalculator patterns,
 * never hard-coded percentages.
 */

import { getPool } from '../db/pool';
import { financialConfigService } from './financialConfigService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: string;  // ISO date YYYY-MM-DD
  to: string;    // ISO date YYYY-MM-DD (inclusive)
}

export interface RevenueSummary {
  totalRevenuePaise: number;
  platformFeesPaise: number;
  commissionPaise: number;
  refundsPaise: number;
  netEarningsPaise: number;
  bookingCount: number;
  completedCount: number;
  cancelledCount: number;
  refundedCount: number;
  avgBookingValuePaise: number;
}

export interface DailyRevenuePoint {
  date: string;
  revenuePaise: number;
  bookingCount: number;
  refundsPaise: number;
}

export interface MonthlyRevenuePoint {
  month: string;          // YYYY-MM
  revenuePaise: number;
  bookingCount: number;
  refundsPaise: number;
  netEarningsPaise: number;
  commissionPaise: number;
  platformFeesPaise: number;
  growthMoM_pct: number | null;
  growthYoY_pct: number | null;
}

export interface ResourcePerformance {
  resourceId: number;
  resourceName: string;
  category: string;
  venueName: string;
  bookingCount: number;
  revenuePaise: number;
  avgBookingValuePaise: number;
  utilization_pct: number;
  rating: number | null;
}

export interface PeakSlot {
  dayOfWeek: number;   // 0=Sun
  dayName: string;
  hour: number;        // 0-23
  bookingCount: number;
  revenuePaise: number;
}

export interface LowDemandSlot {
  date: string;
  hour: number;
  availableSlots: number;
  bookedSlots: number;
  utilization_pct: number;
}

export interface CustomerSegment {
  newCustomers: number;
  returningCustomers: number;
  totalRevenuePaise: number;
  newCustomerRevenuePaise: number;
  returningCustomerRevenuePaise: number;
}

export interface BookingTrends {
  daily: DailyRevenuePoint[];
  monthly: MonthlyRevenuePoint[];
  peakSlots: PeakSlot[];
  lowDemandSlots: LowDemandSlot[];
}

export interface DomainSummary {
  domain: 'turf' | 'event' | 'movie';
  label: string;
  totalBookings: number;
  totalRevenuePaise: number;
  refundsPaise: number;
  netEarningsPaise: number;
  cancelledCount: number;
  completedCount: number;
  avgBookingValuePaise: number;
}

export interface DashboardResponse {
  overview: {
    totalBookings: number;
    totalRevenuePaise: number;
    refundsPaise: number;
    netEarningsPaise: number;
    cancelledCount: number;
    completedCount: number;
    avgBookingValuePaise: number;
    domainsActive: string[];
  };
  domains: DomainSummary[];
  trends: BookingTrends;
  byResource: ResourcePerformance[];
  topResources: ResourcePerformance[];
  underperformingResources: ResourcePerformance[];
  customerSegments: CustomerSegment;
  insights: string[];
}

// ── Movie Analytics Types ──────────────────────────────────────────────────────

export interface MovieRevenueSummary {
  totalRevenuePaise: number;
  bookingCount: number;
  onlineBookingCount: number;
  offlineBookingCount: number;
  avgBookingValuePaise: number;
  topMovie: { title: string; revenuePaise: number; bookingCount: number } | null;
}

export interface MovieRevenueByCinema {
  cinemaId: number;
  cinemaName: string;
  city: string;
  bookingCount: number;
  revenuePaise: number;
}

export interface MovieDailyRevenuePoint {
  date: string;
  revenuePaise: number;
  bookingCount: number;
  offlineCount: number;
  onlineCount: number;
}

export interface MoviePaymentBreakdown {
  paymentMethod: string;
  count: number;
  revenuePaise: number;
}

// ── Event Analytics Types ──────────────────────────────────────────────────────

export interface EventAnalyticsSummary {
  totalBookings: number;
  confirmedBookings: number;
  cancelledBookings: number;
  refundedBookings: number;
  totalTicketsSold: number;
  totalRevenuePaise: number;
  refundsPaise: number;
  netEarningsPaise: number;
  totalEvents: number;
  publishedEvents: number;
  avgBookingValuePaise: number;
  totalCheckIns: number;
}

export interface EventPerformance {
  eventId: number;
  eventTitle: string;
  bookings: number;
  ticketsSold: number;
  revenuePaise: number;
  checkIns: number;
  occupancy_pct: number;
  status: string;
}

export interface EventDailyPoint {
  date: string;
  bookings: number;
  revenuePaise: number;
  ticketsSold: number;
}

export interface EventAnalyticsResponse {
  summary: EventAnalyticsSummary;
  dailyTrends: EventDailyPoint[];
  eventPerformance: EventPerformance[];
  insights: string[];
}

// ── Unified Settlement Types ───────────────────────────────────────────────────

export interface UnifiedSettlement {
  id: number;
  domain: 'turf' | 'event' | 'movie';
  domainLabel: string;
  status: string;
  grossAmount: number;
  commissionAmount: number;
  taxAmount: number;
  netAmount: number;
  gatewayPayoutId: string | null;
  scheduledAt: string;
  completedAt: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Half-open date range: [fromT00:00:00, toNextDayT00:00:00)
 * This correctly includes all timestamps on the "to" date.
 */
function dateRangeBoundaries(from: string, to: string): { fromTs: string; toExclusiveTs: string } {
  // "to" date's exclusive upper bound = next day at midnight
  const nextDay = new Date(to);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const toExclusive = nextDay.toISOString().slice(0, 10) + 'T00:00:00Z';
  return {
    fromTs: from + 'T00:00:00Z',
    toExclusiveTs: toExclusive,
  };
}

/**
 * Get financial config snapshot for the organization.
 * Returns the same config used by the settlement system.
 */
async function getOrgFinancialConfig(orgId: number) {
  return financialConfigService.getSnapshot(orgId);
}

/**
 * SQL expression for platform fee using financial config BPS.
 * platform_fee = gross * platform_fee_bps / 10000, rounded.
 */
function sqlPlatformFee(grossCol: string, configAlias: string = 'fc'): string {
  return `ROUND((${grossCol} * (COALESCE(${configAlias}.platform_fee_bps, 500))::numeric / 10000))::bigint`;
}

/**
 * SQL expression for commission using financial config BPS.
 */
function sqlCommission(grossCol: string, configAlias: string = 'fc'): string {
  return `ROUND((${grossCol} * (COALESCE(${configAlias}.commission_bps, 1000))::numeric / 10000))::bigint`;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class OwnerDashboardService {

  /**
   * Main dashboard endpoint — all data in one call.
   * Cross-domain: turf + event + movie.
   */
  async getDashboard(orgId: number, range: DateRange): Promise<DashboardResponse> {
    const pool = getPool();
    const { fromTs, toExclusiveTs } = dateRangeBoundaries(range.from, range.to);

    // ── Fetch financial config once ─────────────────────────────────────────
    const config = await getOrgFinancialConfig(orgId);
    const platformFeeBps = (config as Record<string, unknown>).platform_fee_bps as number ?? 500;
    const commissionBps = (config as Record<string, unknown>).commission_bps as number ?? 1000;

    // ── 0. Per-domain summaries ──────────────────────────────────────────────
    const domainSummaries = await this._getDomainSummaries(pool, orgId, fromTs, toExclusiveTs, platformFeeBps, commissionBps);

    // ── 1. Turf: Summary with pre-aggregated refunds ─────────────────────────
    const turfSummary = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM turf_refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       )
       SELECT
         COALESCE(SUM(tb.amount), 0)::bigint AS total_revenue_paise,
         COUNT(*) FILTER (WHERE tb.status IN ('checked_in','completed')) AS completed_count,
         COUNT(*) FILTER (WHERE tb.status = 'cancelled') AS cancelled_count,
         COUNT(*) FILTER (WHERE tb.status = 'refunded') AS refunded_count,
         COUNT(*) AS total_bookings,
         COALESCE(SUM(tb.amount) FILTER (WHERE tb.status IN ('checked_in','completed','confirmed')), 0)::bigint AS net_earnings_paise,
         ROUND(SUM(tb.amount) FILTER (WHERE tb.status IN ('checked_in','completed','confirmed')) * $4 / 10000)::bigint AS platform_fees_paise,
         ROUND(SUM(tb.amount) FILTER (WHERE tb.status IN ('checked_in','completed','confirmed')) * $5 / 10000)::bigint AS commission_paise,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM turf_bookings tb
       LEFT JOIN refund_totals rt ON rt.booking_id = tb.id
       WHERE tb.organization_id = $1
         AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
         AND tb.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs, platformFeeBps, commissionBps]
    );

    // ── 2. Event: Summary ────────────────────────────────────────────────────
    const eventSummary = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       )
       SELECT
         COALESCE(SUM(po.amount), 0)::bigint AS total_revenue_paise,
         COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')) AS completed_count,
         COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled_count,
         COUNT(b.id) FILTER (WHERE b.status = 'refunded') AS refunded_count,
         COUNT(b.id) AS total_bookings,
         COALESCE(SUM(po.amount) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')), 0)::bigint AS net_earnings_paise,
         ROUND(SUM(po.amount) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')) * $4 / 10000)::bigint AS platform_fees_paise,
         ROUND(SUM(po.amount) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')) * $5 / 10000)::bigint AS commission_paise,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       LEFT JOIN payment_orders po ON po.booking_id = b.id AND po.booking_type = 'event' AND po.status = 'COMPLETED'
       LEFT JOIN refund_totals rt ON rt.booking_id = b.id
       WHERE e.organization_id = $1
         AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
         AND b.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs, platformFeeBps, commissionBps]
    );

    // ── 3. Movie: Summary ────────────────────────────────────────────────────
    const movieSummary = await pool.query(
      `WITH refund_totals AS (
         -- Movie refund handler does not exist yet.
         -- refunds.booking_id references event bookings (BIGINT), not movie_bookings.id (SERIAL).
         -- This CTE returns no rows for movie_bookings; refunds_paise = 0.
         SELECT booking_id, 0::numeric AS refund_amount WHERE false
       ),
       payment_completed AS (
         SELECT po.booking_id, po.amount
         FROM payment_orders po
         WHERE po.booking_type = 'movie' AND po.status = 'COMPLETED'
       )
       SELECT
         COUNT(*) AS total_bookings,
         COALESCE(SUM(pc.amount), 0)::bigint AS total_revenue_paise,
         COUNT(*) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')) AS completed_count,
         COUNT(*) FILTER (WHERE mb.status = 'cancelled') AS cancelled_count,
         COUNT(*) FILTER (WHERE mb.status = 'refunded') AS refunded_count,
         COALESCE(SUM(pc.amount) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')), 0)::bigint AS net_earnings_paise,
         ROUND(COALESCE(SUM(pc.amount) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')), 0) * $4 / 10000)::bigint AS platform_fees_paise,
         ROUND(COALESCE(SUM(pc.amount) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')), 0) * $5 / 10000)::bigint AS commission_paise,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM movie_bookings mb
       LEFT JOIN refund_totals rt ON rt.booking_id = mb.id
       LEFT JOIN payment_completed pc ON pc.booking_id = mb.id
       WHERE mb.organization_id = $1
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
         AND mb.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs, platformFeeBps, commissionBps]
    );

    // ── Combine domain summaries ─────────────────────────────────────────────
    const turfS = turfSummary.rows[0] as Record<string, string | number> || {};
    const eventS = eventSummary.rows[0] as Record<string, string | number> || {};
    const movieS = movieSummary.rows[0] as Record<string, string | number> || {};

    const totalBookings = Number(turfS.total_bookings ?? 0) + Number(eventS.total_bookings ?? 0) + Number(movieS.total_bookings ?? 0);
    const totalRevenue = Number(turfS.total_revenue_paise ?? 0) + Number(eventS.total_revenue_paise ?? 0) + Number(movieS.total_revenue_paise ?? 0);
    const refundsPaise = Number(turfS.refunds_paise ?? 0) + Number(eventS.refunds_paise ?? 0) + Number(movieS.refunds_paise ?? 0);
    const netEarnings = Number(turfS.net_earnings_paise ?? 0) + Number(eventS.net_earnings_paise ?? 0) + Number(movieS.net_earnings_paise ?? 0);
    const completedCount = Number(turfS.completed_count ?? 0) + Number(eventS.completed_count ?? 0) + Number(movieS.completed_count ?? 0);
    const cancelledCount = Number(turfS.cancelled_count ?? 0) + Number(eventS.cancelled_count ?? 0) + Number(movieS.cancelled_count ?? 0);

    const domainsActive: string[] = [];
    if (Number(turfS.total_bookings ?? 0) > 0) domainsActive.push('turf');
    if (Number(eventS.total_bookings ?? 0) > 0) domainsActive.push('events');
    if (Number(movieS.total_bookings ?? 0) > 0) domainsActive.push('movies');

    const domainSummariesArr: DomainSummary[] = [
      {
        domain: 'turf', label: 'Turf',
        totalBookings: Number(turfS.total_bookings ?? 0),
        totalRevenuePaise: Number(turfS.total_revenue_paise ?? 0),
        refundsPaise: Number(turfS.refunds_paise ?? 0),
        netEarningsPaise: Number(turfS.net_earnings_paise ?? 0),
        cancelledCount: Number(turfS.cancelled_count ?? 0),
        completedCount: Number(turfS.completed_count ?? 0),
        avgBookingValuePaise: Number(turfS.total_bookings ?? 0) > 0 ? Math.round(Number(turfS.total_revenue_paise ?? 0) / Number(turfS.total_bookings ?? 0)) : 0,
      },
      {
        domain: 'event', label: 'Events',
        totalBookings: Number(eventS.total_bookings ?? 0),
        totalRevenuePaise: Number(eventS.total_revenue_paise ?? 0),
        refundsPaise: Number(eventS.refunds_paise ?? 0),
        netEarningsPaise: Number(eventS.net_earnings_paise ?? 0),
        cancelledCount: Number(eventS.cancelled_count ?? 0),
        completedCount: Number(eventS.completed_count ?? 0),
        avgBookingValuePaise: Number(eventS.total_bookings ?? 0) > 0 ? Math.round(Number(eventS.total_revenue_paise ?? 0) / Number(eventS.total_bookings ?? 0)) : 0,
      },
      {
        domain: 'movie', label: 'Movies',
        totalBookings: Number(movieS.total_bookings ?? 0),
        totalRevenuePaise: Number(movieS.total_revenue_paise ?? 0),
        refundsPaise: Number(movieS.refunds_paise ?? 0),
        netEarningsPaise: Number(movieS.net_earnings_paise ?? 0),
        cancelledCount: Number(movieS.cancelled_count ?? 0),
        completedCount: Number(movieS.completed_count ?? 0),
        avgBookingValuePaise: Number(movieS.total_bookings ?? 0) > 0 ? Math.round(Number(movieS.total_revenue_paise ?? 0) / Number(movieS.total_bookings ?? 0)) : 0,
      },
    ];

    const overview = {
      totalBookings,
      totalRevenuePaise: totalRevenue,
      refundsPaise,
      netEarningsPaise: netEarnings,
      cancelledCount,
      completedCount,
      avgBookingValuePaise: totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0,
      domainsActive,
    };

    // ── 4. Turf daily revenue trend (with pre-aggregated refunds) ────────────
    const daily = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM turf_refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       )
       SELECT
         DATE(tb.created_at) AS date,
         COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
         COUNT(*) AS booking_count,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM turf_bookings tb
       LEFT JOIN refund_totals rt ON rt.booking_id = tb.id
       WHERE tb.organization_id = $1
         AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
         AND tb.deleted_at IS NULL
       GROUP BY DATE(tb.created_at)
       ORDER BY date`,
      [orgId, fromTs, toExclusiveTs]
    );

    // ── 5. Turf monthly revenue trend with MoM/YoY ───────────────────────────
    const monthly = await pool.query(
      `WITH monthly_base AS (
         SELECT
           TO_CHAR(tb.created_at, 'YYYY-MM') AS month,
           COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
           COUNT(*) AS booking_count
         FROM turf_bookings tb
         WHERE tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
           AND tb.deleted_at IS NULL
         GROUP BY TO_CHAR(tb.created_at, 'YYYY-MM')
       ),
       refund_monthly AS (
         SELECT
           TO_CHAR(tr.created_at, 'YYYY-MM') AS month,
           COALESCE(SUM(tr.amount), 0)::bigint AS refunds_paise
         FROM turf_refunds tr
         JOIN turf_bookings tb ON tb.id = tr.booking_id
         WHERE tb.organization_id = $1
           AND tr.created_at >= $2::timestamptz AND tr.created_at < $3::timestamptz
         GROUP BY TO_CHAR(tr.created_at, 'YYYY-MM')
       ),
       monthly AS (
         SELECT m.month, m.revenue_paise, m.booking_count,
                COALESCE(rm.refunds_paise, 0)::bigint AS refunds_paise,
                ROUND(m.revenue_paise * $4 / 10000)::bigint AS platform_fees_paise,
                ROUND(m.revenue_paise * $5 / 10000)::bigint AS commission_paise
         FROM monthly_base m
         LEFT JOIN refund_monthly rm ON rm.month = m.month
       ),
       mom AS (
         SELECT month, revenue_paise, booking_count, refunds_paise, platform_fees_paise, commission_paise,
                LAG(revenue_paise) OVER (ORDER BY month) AS prev_month_revenue
         FROM monthly
       ),
       yoy AS (
         SELECT month, revenue_paise,
                LAG(revenue_paise) OVER (ORDER BY month ROWS 11 PRECEDING) AS prev_year_revenue
         FROM monthly
       )
       SELECT m.month, m.revenue_paise, m.booking_count, m.refunds_paise,
              m.platform_fees_paise, m.commission_paise,
              CASE WHEN m.prev_month_revenue > 0 THEN ROUND((m.revenue_paise - m.prev_month_revenue) / m.prev_month_revenue * 100, 2) ELSE NULL END AS growth_mom_pct,
              CASE WHEN m.prev_year_revenue > 0 THEN ROUND((m.revenue_paise - m.prev_year_revenue) / m.prev_year_revenue * 100, 2) ELSE NULL END AS growth_yoy_pct
       FROM mom m
       LEFT JOIN yoy y ON y.month = m.month
       ORDER BY m.month`,
      [orgId, fromTs, toExclusiveTs, platformFeeBps, commissionBps]
    );

    const monthlyPoints = monthly.rows.map((row: Record<string, unknown>) => ({
      month: String(row.month),
      revenuePaise: Number(row.revenue_paise ?? 0),
      bookingCount: Number(row.booking_count ?? 0),
      refundsPaise: Number(row.refunds_paise ?? 0),
      netEarningsPaise: Number(row.revenue_paise ?? 0) - Number(row.refunds_paise ?? 0),
      commissionPaise: Number(row.commission_paise ?? 0),
      platformFeesPaise: Number(row.platform_fees_paise ?? 0),
      growthMoM_pct: row.growth_mom_pct !== null && row.growth_mom_pct !== undefined ? Number(row.growth_mom_pct) : null,
      growthYoY_pct: row.growth_yoy_pct !== null && row.growth_yoy_pct !== undefined ? Number(row.growth_yoy_pct) : null,
    }));

    // ── 6. Resource performance (single query, no N+1) ───────────────────────
    const resources = await pool.query(
      `WITH booking_agg AS (
         SELECT tb.resource_id,
                COUNT(*) AS booking_count,
                COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
                ROUND(COALESCE(SUM(tb.amount), 0) / NULLIF(COUNT(*), 0))::bigint AS avg_booking_paise
         FROM turf_bookings tb
         WHERE tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
           AND tb.deleted_at IS NULL
         GROUP BY tb.resource_id
       ),
       util_agg AS (
         SELECT tau.resource_id,
                COUNT(DISTINCT tau.id) FILTER (WHERE tb.status IN ('confirmed','completed'))::numeric /
                  NULLIF(COUNT(DISTINCT tau.id), 0) * 100 AS util_pct
         FROM turf_availability_units tau
         JOIN turf_bookings tb ON tb.availability_unit_id = tau.id
         WHERE tb.organization_id = $1
           AND tau.starts_at >= $2::timestamptz AND tau.ends_at < $3::timestamptz
         GROUP BY tau.resource_id
       ),
       review_agg AS (
         SELECT tr.resource_id, ROUND(AVG(tr.rating), 1) AS avg_rating
         FROM turf_reviews tr
         WHERE tr.deleted_at IS NULL
         GROUP BY tr.resource_id
       )
       SELECT tr.id AS resource_id, tr.name AS resource_name, tr.category,
              tv.name AS venue_name,
              COALESCE(ba.booking_count, 0) AS booking_count,
              COALESCE(ba.revenue_paise, 0)::bigint AS revenue_paise,
              COALESCE(ba.avg_booking_paise, 0)::bigint AS avg_booking_paise,
              COALESCE(ua.util_pct, 0) AS util_pct,
              COALESCE(ra.avg_rating, 0) AS rating
       FROM turf_resources tr
       JOIN turf_venues tv ON tv.id = tr.venue_id
       LEFT JOIN booking_agg ba ON ba.resource_id = tr.id
       LEFT JOIN util_agg ua ON ua.resource_id = tr.id
       LEFT JOIN review_agg ra ON ra.resource_id = tr.id
       WHERE tv.organization_id = $1 AND tr.deleted_at IS NULL
       GROUP BY tr.id, tr.name, tr.category, tv.name, ba.booking_count, ba.revenue_paise,
                ba.avg_booking_paise, ua.util_pct, ra.avg_rating
       ORDER BY COALESCE(ba.revenue_paise, 0) DESC`,
      [orgId, fromTs, toExclusiveTs]
    );

    const resourceRows: ResourcePerformance[] = resources.rows.map((row: Record<string, unknown>) => ({
      resourceId: Number(row.resource_id),
      resourceName: String(row.resource_name),
      category: String(row.category),
      venueName: String(row.venue_name),
      bookingCount: Number(row.booking_count ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
      avgBookingValuePaise: Number(row.avg_booking_paise ?? 0),
      utilization_pct: Number(row.util_pct ?? 0),
      rating: Number(row.rating ?? 0) || null,
    }));

    const topResources = [...resourceRows].sort((a, b) => b.revenuePaise - a.revenuePaise).slice(0, 10);
    const underperforming = resourceRows.filter(r => r.bookingCount === 0 || r.utilization_pct < 20).slice(0, 10);

    // ── 7. Peak booking slots (by slot time, not creation time) ───────────────
    const peakSlots = await pool.query(
      `SELECT
         EXTRACT(DOW FROM tau.starts_at)::int AS day_of_week,
         EXTRACT(HOUR FROM tau.starts_at)::int AS hour,
         COUNT(tb.id) AS booking_count,
         COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise
       FROM turf_bookings tb
       JOIN turf_availability_units tau ON tau.id = tb.availability_unit_id
       WHERE tb.organization_id = $1
         AND tau.starts_at >= $2::timestamptz AND tau.starts_at < $3::timestamptz
         AND tb.status NOT IN ('cancelled', 'expired', 'pending_payment')
         AND tb.deleted_at IS NULL
       GROUP BY EXTRACT(DOW FROM tau.starts_at), EXTRACT(HOUR FROM tau.starts_at)
       ORDER BY booking_count DESC
       LIMIT 20`,
      [orgId, fromTs, toExclusiveTs]
    );

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const peakSlotRows: PeakSlot[] = peakSlots.rows.map((row: Record<string, unknown>) => ({
      dayOfWeek: Number(row.day_of_week),
      dayName: DAY_NAMES[Number(row.day_of_week)] || '',
      hour: Number(row.hour),
      bookingCount: Number(row.booking_count ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
    }));

    // ── 8. Low demand slots ───────────────────────────────────────────────────
    const lowDemand = await pool.query(
      `WITH available AS (
         SELECT tau.id, tau.starts_at, tau.ends_at, tau.resource_id
         FROM turf_availability_units tau
         JOIN turf_resources tr ON tr.id = tau.resource_id
         JOIN turf_venues tv ON tv.id = tr.venue_id
         WHERE tv.organization_id = $1
           AND tau.starts_at >= $2::timestamptz AND tau.ends_at < $3::timestamptz
           AND tau.status = 'available'
           AND tau.deleted_at IS NULL
       ),
       booked AS (
         SELECT tb.availability_unit_id
         FROM turf_bookings tb
         WHERE tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
           AND tb.status NOT IN ('cancelled', 'expired', 'pending_payment')
           AND tb.deleted_at IS NULL
       )
       SELECT
         DATE(a.starts_at) AS date,
         EXTRACT(HOUR FROM a.starts_at)::int AS hour,
         COUNT(*)::int AS available_slots,
         COUNT(b.availability_unit_id)::int AS booked_slots
       FROM available a
       LEFT JOIN booked b ON b.availability_unit_id = a.id
       GROUP BY DATE(a.starts_at), EXTRACT(HOUR FROM a.starts_at)
       HAVING COUNT(*) > 0
       ORDER BY (COUNT(b.availability_unit_id)::numeric / NULLIF(COUNT(*), 0)) ASC
       LIMIT 20`,
      [orgId, fromTs, toExclusiveTs]
    );

    const lowDemandRows: LowDemandSlot[] = lowDemand.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      hour: Number(row.hour),
      availableSlots: Number(row.available_slots ?? 0),
      bookedSlots: Number(row.booked_slots ?? 0),
      utilization_pct: Number(row.available_slots) > 0
        ? Number(((Number(row.booked_slots ?? 0) / Number(row.available_slots)) * 100).toFixed(1))
        : 0,
    }));

    // ── 9. Customer segments (multi-domain: turf + event + movie) ─────────────
    const customerSegments = await pool.query(
      `WITH customer_stats AS (
         SELECT u.id AS user_id,
                COUNT(tb.id) AS turf_bookings,
                COUNT(b.id)  AS event_bookings,
                COUNT(mb.id) AS movie_bookings,
                COUNT(tb.id) + COUNT(b.id) + COUNT(mb.id) AS booking_count
         FROM users u
         LEFT JOIN turf_bookings tb
           ON tb.user_id = u.id AND tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
           AND tb.status NOT IN ('cancelled','expired','pending_payment')
           AND tb.deleted_at IS NULL
         LEFT JOIN bookings b
           ON b.user_id = u.id AND b.event_id IN (
             SELECT id FROM events WHERE organization_id = $1
           )
           AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
           AND b.ticket_count > 0
         LEFT JOIN movie_bookings mb
           ON mb.user_id = u.id AND mb.organization_id = $1
           AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
           AND mb.status NOT IN ('cancelled','expired','pending_payment')
           AND mb.deleted_at IS NULL
         GROUP BY u.id
       )
       SELECT
         COUNT(*) FILTER (WHERE booking_count = 1) AS new_customers,
         COUNT(*) FILTER (WHERE booking_count > 1) AS returning_customers
       FROM customer_stats`,
      [orgId, fromTs, toExclusiveTs]
    );

    const cs = (customerSegments.rows[0] as Record<string, string | number>) ?? {};
    const customerSeg: CustomerSegment = {
      newCustomers: Number(cs.new_customers ?? 0),
      returningCustomers: Number(cs.returning_customers ?? 0),
      totalRevenuePaise: 0,
      newCustomerRevenuePaise: 0,
      returningCustomerRevenuePaise: 0,
    };

    // ── 10. Build revenue summary (turf-only for backward compat in trends) ──
    const s = turfSummary.rows[0] as Record<string, string | number> || {};
    const turfTotalBookings = Number(s.total_bookings ?? 0);
    const turfRevenue = Number(s.total_revenue_paise ?? 0);
    const revenueSummary: RevenueSummary = {
      totalRevenuePaise: turfRevenue,
      platformFeesPaise: Number(s.platform_fees_paise ?? 0),
      commissionPaise: Number(s.commission_paise ?? 0),
      refundsPaise,
      netEarningsPaise: netEarnings,
      bookingCount: totalBookings,
      completedCount,
      cancelledCount,
      refundedCount: Number(s.refunded_count ?? 0) + Number(eventS.refunded_count ?? 0) + Number(movieS.refunded_count ?? 0),
      avgBookingValuePaise: totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0,
    };

    // ── 11. Insights ───────────────────────────────────────────────────────────
    const insights = this.generateInsights({
      overview,
      domains: domainSummariesArr,
      monthly: monthlyPoints,
      resources: resourceRows,
      peakSlots: peakSlotRows,
      lowDemandSlots: lowDemandRows,
      customerSegments: customerSeg,
    });

    return {
      overview,
      domains: domainSummariesArr,
      trends: {
        daily: daily.rows.map((row: Record<string, unknown>) => ({
          date: String(row.date),
          revenuePaise: Number(row.revenue_paise ?? 0),
          bookingCount: Number(row.booking_count ?? 0),
          refundsPaise: Number(row.refunds_paise ?? 0),
        })),
        monthly: monthlyPoints,
        peakSlots: peakSlotRows,
        lowDemandSlots: lowDemandRows,
      },
      byResource: resourceRows,
      topResources: topResources,
      underperformingResources: underperforming,
      customerSegments: customerSeg,
      insights,
    };
  }

  /**
   * Per-domain summary queries for the overview section.
   */
  private async _getDomainSummaries(
    pool: ReturnType<typeof getPool>,
    orgId: number,
    fromTs: string,
    toExclusiveTs: string,
    platformFeeBps: number,
    commissionBps: number
  ): Promise<{
    turf: { total_bookings: number; total_revenue_paise: number; refunds_paise: number; net_earnings_paise: number; cancelled_count: number; completed_count: number; refunded_count: number };
    event: { total_bookings: number; total_revenue_paise: number; refunds_paise: number; net_earnings_paise: number; cancelled_count: number; completed_count: number; refunded_count: number };
    movie: { total_bookings: number; total_revenue_paise: number; refunds_paise: number; net_earnings_paise: number; cancelled_count: number; completed_count: number; refunded_count: number };
  }> {
    // Turf summary
    const turfResult = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM turf_refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       )
       SELECT
         COUNT(*) AS total_bookings,
         COALESCE(SUM(amount), 0)::bigint AS total_revenue_paise,
         COUNT(*) FILTER (WHERE status IN ('checked_in','completed')) AS completed_count,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
         COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_count,
         COALESCE(SUM(amount) FILTER (WHERE status IN ('checked_in','completed','confirmed')), 0)::bigint AS net_earnings_paise,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM turf_bookings tb
       LEFT JOIN refund_totals rt ON rt.booking_id = tb.id
       WHERE tb.organization_id = $1
         AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
         AND tb.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs]
    );

    // Event summary
    const eventResult = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       )
       SELECT
         COUNT(b.id) AS total_bookings,
         COALESCE(SUM(po.amount), 0)::bigint AS total_revenue_paise,
         COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')) AS completed_count,
         COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled_count,
         COUNT(b.id) FILTER (WHERE b.status = 'refunded') AS refunded_count,
         COALESCE(SUM(po.amount) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')), 0)::bigint AS net_earnings_paise,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       LEFT JOIN payment_orders po ON po.booking_id = b.id AND po.booking_type = 'event' AND po.status = 'COMPLETED'
       LEFT JOIN refund_totals rt ON rt.booking_id = b.id
       WHERE e.organization_id = $1
         AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
         AND b.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs]
    );

    // Movie summary
    // Movie refund handler does not exist yet (refunds.booking_id references event bookings, not movie_bookings.id).
    // Revenue is sourced from payment_orders with booking_type='movie' AND status='COMPLETED' (payment-verified).
    const movieResult = await pool.query(
      `SELECT
         COUNT(mb.id) AS total_bookings,
         COALESCE(SUM(po.amount), 0)::bigint AS total_revenue_paise,
         COUNT(mb.id) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')) AS completed_count,
         COUNT(mb.id) FILTER (WHERE mb.status = 'cancelled') AS cancelled_count,
         COUNT(mb.id) FILTER (WHERE mb.status = 'refunded') AS refunded_count,
         COALESCE(SUM(po.amount) FILTER (WHERE mb.status IN ('confirmed','completed','checked_in')), 0)::bigint AS net_earnings_paise,
         0::bigint AS refunds_paise
       FROM movie_bookings mb
       LEFT JOIN payment_orders po ON po.booking_id = mb.id AND po.booking_type = 'movie' AND po.status = 'COMPLETED'
       WHERE mb.organization_id = $1
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
         AND mb.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs]
    );

    const turf = (turfResult.rows[0] || {}) as Record<string, string | number>;
    const event = (eventResult.rows[0] || {}) as Record<string, string | number>;
    const movie = (movieResult.rows[0] || {}) as Record<string, string | number>;

    return {
      turf: {
        total_bookings: Number(turf.total_bookings ?? 0),
        total_revenue_paise: Number(turf.total_revenue_paise ?? 0),
        refunds_paise: Number(turf.refunds_paise ?? 0),
        net_earnings_paise: Number(turf.net_earnings_paise ?? 0),
        cancelled_count: Number(turf.cancelled_count ?? 0),
        completed_count: Number(turf.completed_count ?? 0),
        refunded_count: Number(turf.refunded_count ?? 0),
      },
      event: {
        total_bookings: Number(event.total_bookings ?? 0),
        total_revenue_paise: Number(event.total_revenue_paise ?? 0),
        refunds_paise: Number(event.refunds_paise ?? 0),
        net_earnings_paise: Number(event.net_earnings_paise ?? 0),
        cancelled_count: Number(event.cancelled_count ?? 0),
        completed_count: Number(event.completed_count ?? 0),
        refunded_count: Number(event.refunded_count ?? 0),
      },
      movie: {
        total_bookings: Number(movie.total_bookings ?? 0),
        total_revenue_paise: Number(movie.total_revenue_paise ?? 0),
        refunds_paise: Number(movie.refunds_paise ?? 0),
        net_earnings_paise: Number(movie.net_earnings_paise ?? 0),
        cancelled_count: Number(movie.cancelled_count ?? 0),
        completed_count: Number(movie.completed_count ?? 0),
        refunded_count: Number(movie.refunded_count ?? 0),
      },
    };
  }

  /**
   * Settlement history — unified across turf, event, and movie domains.
   *
   * Movie settlements are stored in turf_settlements (shared table), so the
   * domain column disambiguates: 1 = turf, 2 = event, 3 = movie.
   */
  async getSettlementHistory(orgId: number, limit = 50): Promise<UnifiedSettlement[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const { rows } = await getPool().query(
      `SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount,
              status, gateway_payout_id, scheduled_at, completed_at, created_at, 'turf'::text AS domain
       FROM turf_settlements
       WHERE organization_id = $1
       UNION ALL
       SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount,
              status, gateway_payout_id, scheduled_at, completed_at, created_at, 'event'::text AS domain
       FROM event_settlements
       WHERE organization_id = $1
       UNION ALL
       SELECT id, organization_id, gross_amount, commission_amount, tax_amount, net_amount,
              status, gateway_payout_id, scheduled_at, completed_at, created_at, 'movie'::text AS domain
       FROM turf_settlements
       WHERE organization_id = $1
         AND (metadata->>'domain') = 'movie'
       ORDER BY created_at DESC
       LIMIT $2`,
      [orgId, safeLimit]
    );

    return (rows as Array<Record<string, unknown>>).map(row => {
      const id = Number(row.id);
      const domain = String(row.domain || 'turf') as 'turf' | 'event' | 'movie';
      const domainLabels: Record<string, string> = { turf: 'Turf', event: 'Events', movie: 'Movies' };

      return {
        id,
        domain,
        domainLabel: domainLabels[domain] || domain,
        status: String(row.status),
        grossAmount: Number(row.gross_amount ?? 0),
        commissionAmount: Number(row.commission_amount ?? 0),
        taxAmount: Number(row.tax_amount ?? 0),
        netAmount: Number(row.net_amount ?? 0),
        gatewayPayoutId: row.gateway_payout_id ? String(row.gateway_payout_id) : null,
        scheduledAt: String(row.scheduled_at),
        completedAt: row.completed_at ? String(row.completed_at) : null,
        createdAt: String(row.created_at),
      };
    });
  }

  /**
   * Movie analytics (existing, preserved).
   */
  async getMovieAnalytics(orgId: number, range: DateRange): Promise<{
    summary: MovieRevenueSummary;
    daily: MovieDailyRevenuePoint[];
    topMovies: Array<{ title: string; revenuePaise: number; bookingCount: number }>;
    paymentBreakdown: MoviePaymentBreakdown[];
  }> {
    const pool = getPool();
    const { fromTs, toExclusiveTs } = dateRangeBoundaries(range.from, range.to);

    // ── Summary ───────────────────────────────────────────────────────────────
    // Revenue sourced from payment_orders with booking_type='movie' AND status='COMPLETED'.
    const summaryResult = await pool.query(
      `SELECT
         COALESCE(SUM(po.amount), 0)::bigint AS total_revenue_paise,
         COUNT(mb.id) AS booking_count,
         COUNT(mb.id) FILTER (WHERE mb.booking_type = 'online') AS online_count,
         COUNT(mb.id) FILTER (WHERE mb.booking_type = 'offline') AS offline_count,
         CASE WHEN COUNT(mb.id) > 0 THEN ROUND(COALESCE(SUM(po.amount), 0) / COUNT(mb.id)) ELSE 0 END AS avg_booking_paise,
         m.title AS top_movie_title,
         COALESCE(SUM(po.amount), 0) AS top_movie_revenue,
         COUNT(mb.id) AS top_movie_bookings
       FROM movie_bookings mb
       JOIN movies m ON m.id = mb.movie_id
       LEFT JOIN payment_orders po ON po.booking_id = mb.id AND po.booking_type = 'movie' AND po.status = 'COMPLETED'
       WHERE mb.organization_id = $1 AND mb.deleted_at IS NULL
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
       GROUP BY m.title
       ORDER BY COALESCE(SUM(po.amount), 0) DESC
       LIMIT 1`,
      [orgId, fromTs, toExclusiveTs]
    );

    const topRow = summaryResult.rows[0] as Record<string, unknown> | undefined;
    const summary: MovieRevenueSummary = {
      totalRevenuePaise: topRow ? Number(topRow.total_revenue_paise ?? 0) : 0,
      bookingCount: topRow ? Number(topRow.booking_count ?? 0) : 0,
      onlineBookingCount: topRow ? Number(topRow.online_count ?? 0) : 0,
      offlineBookingCount: topRow ? Number(topRow.offline_count ?? 0) : 0,
      avgBookingValuePaise: topRow ? Number(topRow.avg_booking_paise ?? 0) : 0,
      topMovie: topRow && topRow.top_movie_title
        ? { title: String(topRow.top_movie_title), revenuePaise: Number(topRow.top_movie_revenue ?? 0), bookingCount: Number(topRow.top_movie_bookings ?? 0) }
        : null,
    };

    // ── Daily revenue trend ────────────────────────────────────────────────────
    // Revenue from payment_orders (payment-verified). Booking counts from movie_bookings.
    const dailyResult = await pool.query(
      `SELECT
         DATE(mb.created_at) AS date,
         COALESCE(SUM(po.amount), 0)::bigint AS revenue_paise,
         COUNT(mb.id) AS booking_count,
         COUNT(mb.id) FILTER (WHERE mb.booking_type = 'offline') AS offline_count,
         COUNT(mb.id) FILTER (WHERE mb.booking_type = 'online') AS online_count
       FROM movie_bookings mb
       LEFT JOIN payment_orders po ON po.booking_id = mb.id AND po.booking_type = 'movie' AND po.status = 'COMPLETED'
       WHERE mb.organization_id = $1 AND mb.deleted_at IS NULL
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
       GROUP BY DATE(mb.created_at)
       ORDER BY date`,
      [orgId, fromTs, toExclusiveTs]
    );

    const daily = dailyResult.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      revenuePaise: Number(row.revenue_paise ?? 0),
      bookingCount: Number(row.booking_count ?? 0),
      offlineCount: Number(row.offline_count ?? 0),
      onlineCount: Number(row.online_count ?? 0),
    }));

    // ── Top movies by revenue ─────────────────────────────────────────────────
    // Revenue from payment_orders (payment-verified).
    const topMoviesResult = await pool.query(
      `SELECT m.title,
         COUNT(mb.id) AS booking_count,
         COALESCE(SUM(po.amount), 0)::bigint AS revenue_paise
       FROM movie_bookings mb
       JOIN movies m ON m.id = mb.movie_id
       LEFT JOIN payment_orders po ON po.booking_id = mb.id AND po.booking_type = 'movie' AND po.status = 'COMPLETED'
       WHERE mb.organization_id = $1 AND mb.deleted_at IS NULL
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
       GROUP BY m.title
       ORDER BY revenue_paise DESC
       LIMIT 10`,
      [orgId, fromTs, toExclusiveTs]
    );

    const topMovies = topMoviesResult.rows.map((row: Record<string, unknown>) => ({
      title: String(row.title),
      revenuePaise: Number(row.revenue_paise ?? 0),
      bookingCount: Number(row.booking_count ?? 0),
    }));

    // ── Payment method breakdown ──────────────────────────────────────────────
    const paymentResult = await pool.query(
      `SELECT po.payment_method,
         COUNT(DISTINCT po.booking_id) AS booking_count,
         COALESCE(SUM(po.amount), 0)::bigint AS revenue_paise
       FROM payment_orders po
       JOIN movie_bookings mb ON mb.id = po.booking_id
       WHERE mb.organization_id = $1 AND po.booking_type = 'movie'
         AND po.status = 'COMPLETED'
         AND mb.created_at >= $2::timestamptz AND mb.created_at < $3::timestamptz
       GROUP BY po.payment_method
       ORDER BY revenue_paise DESC`,
      [orgId, fromTs, toExclusiveTs]
    );

    const paymentBreakdown = paymentResult.rows.map((row: Record<string, unknown>) => ({
      paymentMethod: String(row.payment_method ?? 'unknown'),
      count: Number(row.booking_count ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
    }));

    return { summary, daily, topMovies, paymentBreakdown };
  }

  /**
   * Event analytics — NEW endpoint for event organizers.
   * All results scoped to the organization.
   */
  async getEventAnalytics(orgId: number, range: DateRange): Promise<EventAnalyticsResponse> {
    const pool = getPool();
    const { fromTs, toExclusiveTs } = dateRangeBoundaries(range.from, range.to);

    // ── Summary ───────────────────────────────────────────────────────────────
    const summaryResult = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       ),
       ticket_counts AS (
         SELECT b.id AS booking_id, COALESCE(SUM(bz.ticket_count), 0) AS tickets
         FROM bookings b
         LEFT JOIN booking_zones bz ON bz.booking_id = b.id
         WHERE b.event_id IN (SELECT id FROM events WHERE organization_id = $1)
           AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
           AND b.deleted_at IS NULL
         GROUP BY b.id
       ),
       checkin_counts AS (
         SELECT ci.event_id, COUNT(*) AS checkin_count
         FROM check_ins ci
         WHERE ci.event_id IN (SELECT id FROM events WHERE organization_id = $1)
           AND ci.created_at >= $2::timestamptz AND ci.created_at < $3::timestamptz
         GROUP BY ci.event_id
       )
       SELECT
         COUNT(b.id) AS total_bookings,
         COUNT(b.id) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')) AS confirmed_bookings,
         COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled_bookings,
         COUNT(b.id) FILTER (WHERE b.status = 'refunded') AS refunded_bookings,
         COALESCE(SUM(tc.tickets), 0) AS total_tickets_sold,
         COALESCE(SUM(po.amount), 0)::bigint AS total_revenue_paise,
         COUNT(DISTINCT e.id) AS total_events,
         COUNT(DISTINCT e.id) FILTER (WHERE e.status = 'published') AS published_events,
         COALESCE(SUM(rt.refund_amount), 0)::bigint AS refunds_paise,
         COALESCE(SUM(po.amount) FILTER (WHERE b.status IN ('confirmed','completed','checked_in')), 0)::bigint AS net_earnings_paise,
         COALESCE(SUM(cc.checkin_count), 0) AS total_checkins
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       LEFT JOIN payment_orders po ON po.booking_id = b.id AND po.booking_type = 'event' AND po.status = 'COMPLETED'
       LEFT JOIN refund_totals rt ON rt.booking_id = b.id
       LEFT JOIN ticket_counts tc ON tc.booking_id = b.id
       LEFT JOIN checkin_counts cc ON cc.event_id = e.id
       WHERE e.organization_id = $1
         AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
         AND b.deleted_at IS NULL`,
      [orgId, fromTs, toExclusiveTs]
    );

    const sumRow = (summaryResult.rows[0] || {}) as Record<string, string | number>;
    const totalBookings = Number(sumRow.total_bookings ?? 0);

    const summary: EventAnalyticsSummary = {
      totalBookings,
      confirmedBookings: Number(sumRow.confirmed_bookings ?? 0),
      cancelledBookings: Number(sumRow.cancelled_bookings ?? 0),
      refundedBookings: Number(sumRow.refunded_bookings ?? 0),
      totalTicketsSold: Number(sumRow.total_tickets_sold ?? 0),
      totalRevenuePaise: Number(sumRow.total_revenue_paise ?? 0),
      refundsPaise: Number(sumRow.refunds_paise ?? 0),
      netEarningsPaise: Number(sumRow.net_earnings_paise ?? 0),
      totalEvents: Number(sumRow.total_events ?? 0),
      publishedEvents: Number(sumRow.published_events ?? 0),
      avgBookingValuePaise: totalBookings > 0 ? Math.round(Number(sumRow.total_revenue_paise ?? 0) / totalBookings) : 0,
      totalCheckIns: Number(sumRow.total_checkins ?? 0),
    };

    // ── Daily trends ──────────────────────────────────────────────────────────
    const dailyResult = await pool.query(
      `SELECT
         DATE(b.created_at) AS date,
         COUNT(b.id) AS bookings,
         COALESCE(SUM(po.amount), 0)::bigint AS revenue_paise,
         COALESCE(SUM(tc.tickets), 0) AS tickets_sold
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       LEFT JOIN payment_orders po ON po.booking_id = b.id AND po.booking_type = 'event' AND po.status = 'COMPLETED'
       LEFT JOIN (
         SELECT bz.booking_id, COALESCE(SUM(bz.ticket_count), 0) AS tickets
         FROM booking_zones bz
         GROUP BY bz.booking_id
       ) tc ON tc.booking_id = b.id
       WHERE e.organization_id = $1
         AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
         AND b.deleted_at IS NULL
       GROUP BY DATE(b.created_at)
       ORDER BY date`,
      [orgId, fromTs, toExclusiveTs]
    );

    const dailyTrends: EventDailyPoint[] = dailyResult.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      bookings: Number(row.bookings ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
      ticketsSold: Number(row.tickets_sold ?? 0),
    }));

    // ── Per-event performance ─────────────────────────────────────────────────
    const eventPerfResult = await pool.query(
      `WITH refund_totals AS (
         SELECT booking_id, SUM(amount) AS refund_amount
         FROM refunds
         WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY booking_id
       ),
       ticket_counts AS (
         SELECT b.id AS booking_id, COALESCE(SUM(bz.ticket_count), 0) AS tickets
         FROM bookings b
         LEFT JOIN booking_zones bz ON bz.booking_id = b.id
         WHERE b.event_id = e.id
           AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
           AND b.deleted_at IS NULL
         GROUP BY b.id
       ),
       checkin_counts AS (
         SELECT ci.event_id, COUNT(*) AS checkin_count
         FROM check_ins ci
         WHERE ci.event_id = e.id
           AND ci.created_at >= $2::timestamptz AND ci.created_at < $3::timestamptz
         GROUP BY ci.event_id
       )
       SELECT
         e.id AS event_id,
         e.title AS event_title,
         COUNT(b.id) AS bookings,
         COALESCE(SUM(tc.tickets), 0) AS tickets_sold,
         COALESCE(SUM(po.amount), 0)::bigint AS revenue_paise,
         COALESCE(cc.checkin_count, 0) AS checkins,
         e.capacity,
         e.status
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
         AND b.created_at >= $2::timestamptz AND b.created_at < $3::timestamptz
         AND b.deleted_at IS NULL
         AND b.status NOT IN ('cancelled', 'expired', 'pending_payment')
       LEFT JOIN payment_orders po ON po.booking_id = b.id AND po.booking_type = 'event' AND po.status = 'COMPLETED'
       LEFT JOIN ticket_counts tc ON tc.booking_id = b.id
       LEFT JOIN checkin_counts cc ON cc.event_id = e.id
       LEFT JOIN refund_totals rt ON rt.booking_id = b.id
       WHERE e.organization_id = $1
         AND e.deleted_at IS NULL
       GROUP BY e.id, e.title, e.capacity, e.status
       ORDER BY revenue_paise DESC
       LIMIT 20`,
      [orgId, fromTs, toExclusiveTs]
    );

    const eventPerformance: EventPerformance[] = eventPerfResult.rows.map((row: Record<string, unknown>) => {
      const capacity = Number(row.capacity ?? 0);
      const ticketsSold = Number(row.tickets_sold ?? 0);
      return {
        eventId: Number(row.event_id),
        eventTitle: String(row.event_title),
        bookings: Number(row.bookings ?? 0),
        ticketsSold,
        revenuePaise: Number(row.revenue_paise ?? 0),
        checkIns: Number(row.checkins ?? 0),
        occupancy_pct: capacity > 0 ? Number((ticketsSold / capacity * 100).toFixed(1)) : 0,
        status: String(row.status),
      };
    });

    // ── Insights ──────────────────────────────────────────────────────────────
    const insights: string[] = [];
    if (summary.totalEvents > 0) {
      const pubPct = (summary.publishedEvents / summary.totalEvents) * 100;
      insights.push(`${summary.publishedEvents} of ${summary.totalEvents} events published (${pubPct.toFixed(0)}%).`);
    }
    if (summary.totalCheckIns > 0 && summary.totalTicketsSold > 0) {
      const checkinPct = (summary.totalCheckIns / summary.totalTicketsSold) * 100;
      insights.push(`${checkinPct.toFixed(0)}% check-in rate across ${summary.totalTicketsSold} tickets sold.`);
    }
    if (summary.refundsPaise > 0 && summary.totalRevenuePaise > 0) {
      const refundRate = (summary.refundsPaise / summary.totalRevenuePaise) * 100;
      if (refundRate > 15) {
        insights.push(`Event refund rate is ${refundRate.toFixed(1)}% — above healthy threshold. Review cancellation policies.`);
      }
    }
    const topEvent = eventPerformance[0];
    if (topEvent && topEvent.revenuePaise > 0) {
      insights.push(`Top event: "${topEvent.eventTitle}" with ₹${(topEvent.revenuePaise / 100).toFixed(2)} revenue.`);
    }
    const noBookingEvents = eventPerformance.filter(e => e.bookings === 0);
    if (noBookingEvents.length > 0) {
      insights.push(`${noBookingEvents.length} published events have zero bookings — review pricing or promotion.`);
    }

    return { summary, dailyTrends, eventPerformance, insights };
  }

  // ── Private: Insights ────────────────────────────────────────────────────────

  private generateInsights(data: {
    overview: DashboardResponse['overview'];
    domains: DomainSummary[];
    monthly: MonthlyRevenuePoint[];
    resources: ResourcePerformance[];
    peakSlots: PeakSlot[];
    lowDemandSlots: LowDemandSlot[];
    customerSegments: CustomerSegment;
  }): string[] {
    const insights: string[] = [];

    // Domain mix
    const activeDomains = data.overview.domainsActive;
    if (activeDomains.length > 1) {
      insights.push(`Active domains: ${activeDomains.join(', ')}. Dashboard aggregates across all active domains.`);
    } else if (activeDomains.length === 1) {
      insights.push(`Active domain: ${activeDomains[0]}. Dashboard shows ${activeDomains[0]}-only metrics.`);
    }

    // Revenue trend insight
    if (data.monthly.length >= 2) {
      const last = data.monthly[data.monthly.length - 1];
      const prev = data.monthly[data.monthly.length - 2];
      if (last && prev && last.growthMoM_pct !== null) {
        if (last.growthMoM_pct > 10) {
          insights.push(`Revenue grew ${last.growthMoM_pct.toFixed(1)}% month-over-month — strong momentum.`);
        } else if (last.growthMoM_pct < -10) {
          insights.push(`Revenue declined ${Math.abs(last.growthMoM_pct).toFixed(1)}% month-over-month — investigate causes.`);
        }
      }
    }

    // Domain breakdown insight
    for (const d of data.domains) {
      if (d.totalBookings > 0) {
        const pct = (d.totalRevenuePaise / data.overview.totalRevenuePaise) * 100;
        insights.push(`${d.label}: ${d.totalBookings} bookings, ₹${(d.totalRevenuePaise / 100).toFixed(2)} revenue (${pct.toFixed(0)}% of total).`);
      }
    }

    // Peak slot insight
    if (data.peakSlots.length > 0) {
      const top = data.peakSlots[0];
      insights.push(`Peak demand: ${top.dayName} ${top.hour}:00–${top.hour + 1}:00 (${top.bookingCount} bookings). Consider premium pricing for this slot.`);
    }

    // Low demand insight
    const lowD = data.lowDemandSlots.filter(s => s.utilization_pct < 20);
    if (lowD.length > 0) {
      insights.push(`${lowD.length} time slots have <20% utilization. Consider bundled offers or dynamic pricing to fill gaps.`);
    }

    // Top resource
    if (data.resources.length > 0) {
      const topR = [...data.resources].sort((a, b) => b.revenuePaise - a.revenuePaise)[0];
      insights.push(`Top performer: "${topR.resourceName}" (${topR.venueName}) with ₹${(topR.revenuePaise / 100).toFixed(2)} revenue.`);
    }

    // Underperforming
    const under = data.resources.filter(r => r.bookingCount === 0);
    if (under.length > 0) {
      insights.push(`${under.length} resources had zero bookings in this period — review pricing, availability, or promotion strategy.`);
    }

    // Customer retention
    const totalCust = data.customerSegments.newCustomers + data.customerSegments.returningCustomers;
    if (totalCust > 0) {
      const retPct = (data.customerSegments.returningCustomers / totalCust) * 100;
      if (retPct < 30) {
        insights.push(`Only ${retPct.toFixed(0)}% of customers are returning — focus on loyalty programs to improve retention.`);
      } else if (retPct > 60) {
        insights.push(`Strong retention: ${retPct.toFixed(0)}% returning customers — maintain engagement to sustain loyalty.`);
      }
    }

    // Average booking value
    if (data.overview.avgBookingValuePaise > 0) {
      insights.push(`Average booking value: ₹${(data.overview.avgBookingValuePaise / 100).toFixed(2)}. Small upsells or bundles could increase this.`);
    }

    // Refund rate
    if (data.overview.totalBookings > 0) {
      const refundRate = (data.overview.refundsPaise / data.overview.totalRevenuePaise) * 100;
      if (refundRate > 15) {
        insights.push(`Overall refund rate is ${refundRate.toFixed(1)}% — above healthy threshold. Review cancellation policies.`);
      }
    }

    return insights;
  }
}

export const ownerDashboardService = new OwnerDashboardService();
