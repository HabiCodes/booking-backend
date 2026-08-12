/**
 * OwnerDashboardService — aggregated revenue and business-growth analytics.
 *
 * All heavy lifting is done in PostgreSQL via CTEs and window functions.
 * Results are returned as typed DTOs — never raw rows.
 *
 * Authorization is the caller's responsibility (organizerAuthMiddleware + org scoping).
 */

import { getPool } from '../db/pool';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DateRange {
  from: string;  // ISO date
  to: string;    // ISO date
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

export interface DashboardResponse {
  summary: RevenueSummary;
  trends: BookingTrends;
  byResource: ResourcePerformance[];
  topResources: ResourcePerformance[];
  underperformingResources: ResourcePerformance[];
  customerSegments: CustomerSegment;
  insights: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function inRange(column: string, range: DateRange): { sql: string; params: unknown[] } {
  return {
    sql: `${column} >= $1 AND ${column} < $2`,
    params: [range.from + 'T00:00:00Z', range.to + 'T23:59:59Z'],
  };
}

function paiseToRupeesStr(paise: number): string {
  return (paise / 100).toFixed(2);
}



// ── Service ──────────────────────────────────────────────────────────────────

export class OwnerDashboardService {

  /**
   * Main dashboard endpoint — all data in one call.
   */
  async getDashboard(orgId: number, range: DateRange): Promise<DashboardResponse> {
    const pool = getPool();
    const r = inRange('tb.created_at', range);
    const params: unknown[] = [orgId, ...r.params];

    // ── 1. Summary ───────────────────────────────────────────────────────────
    const summary = await pool.query(
      `SELECT
         COALESCE(SUM(tb.amount), 0)::bigint AS total_revenue_paise,
         COUNT(*) FILTER (WHERE tb.status IN ('checked_in','completed')) AS completed_count,
         COUNT(*) FILTER (WHERE tb.status = 'cancelled') AS cancelled_count,
         COUNT(*) FILTER (WHERE tb.status = 'refunded') AS refunded_count,
         COUNT(*) AS total_bookings,
         COALESCE(SUM(tb.amount) FILTER (WHERE tb.status IN ('checked_in','completed','confirmed')), 0)::bigint AS net_earnings_paise,
         COALESCE(SUM(CASE WHEN tb.amount IS NOT NULL THEN tb.amount * 0.05 ELSE 0 END), 0)::bigint AS platform_fees_paise,
         COALESCE(SUM(CASE WHEN tb.amount IS NOT NULL THEN tb.amount * 0.10 ELSE 0 END), 0)::bigint AS commission_paise,
         COALESCE(SUM(tr.amount), 0)::bigint AS refunds_paise
       FROM turf_bookings tb
       LEFT JOIN turf_refunds tr ON tr.booking_id = tb.id AND tr.organization_id = tb.organization_id
       WHERE tb.organization_id = $1 AND ${r.sql}`,
      params
    );

    const s = (summary.rows[0] as Record<string, string | number>) ?? {};
    const totalBookings = Number(s.total_bookings ?? 0);
    const netEarnings = Number(s.net_earnings_paise ?? 0);
    const totalRevenue = Number(s.total_revenue_paise ?? 0);
    const refundsPaise = Number(s.refunds_paise ?? 0);

    const revenueSummary: RevenueSummary = {
      totalRevenuePaise: totalRevenue,
      platformFeesPaise: Number(s.platform_fees_paise ?? 0),
      commissionPaise: Number(s.commission_paise ?? 0),
      refundsPaise,
      netEarningsPaise: netEarnings,
      bookingCount: totalBookings,
      completedCount: Number(s.completed_count ?? 0),
      cancelledCount: Number(s.cancelled_count ?? 0),
      refundedCount: Number(s.refunded_count ?? 0),
      avgBookingValuePaise: totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0,
    };

    // ── 2. Daily revenue trend ────────────────────────────────────────────────
    const daily = await pool.query(
      `SELECT
         DATE(tb.created_at) AS date,
         COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
         COUNT(*) AS booking_count,
         COALESCE(SUM(tr.amount), 0)::bigint AS refunds_paise
       FROM turf_bookings tb
       LEFT JOIN turf_refunds tr ON tr.booking_id = tb.id AND tr.organization_id = tb.organization_id
       WHERE tb.organization_id = $1 AND ${r.sql}
       GROUP BY DATE(tb.created_at)
       ORDER BY date`,
      params
    );

    // ── 3. Monthly revenue trend with MoM/YoY ────────────────────────────────
    const monthly = await pool.query(
      `WITH monthly AS (
         SELECT
           TO_CHAR(tb.created_at, 'YYYY-MM') AS month,
           COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
           COUNT(*) AS booking_count,
           COALESCE(SUM(tr.amount), 0)::bigint AS refunds_paise,
           COALESCE(SUM(CASE WHEN tb.amount IS NOT NULL THEN tb.amount * 0.05 ELSE 0 END), 0)::bigint AS platform_fees_paise,
           COALESCE(SUM(CASE WHEN tb.amount IS NOT NULL THEN tb.amount * 0.10 ELSE 0 END), 0)::bigint AS commission_paise
         FROM turf_bookings tb
         LEFT JOIN turf_refunds tr ON tr.booking_id = tb.id AND tr.organization_id = tb.organization_id
         WHERE tb.organization_id = $1 AND tb.created_at >= $2::timestamptz - INTERVAL '18 months'
         GROUP BY TO_CHAR(tb.created_at, 'YYYY-MM')
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
      [orgId, range.from + 'T00:00:00Z']
    );

    const monthlyPoints = monthly.rows.map((row: Record<string, unknown>) => ({
      month: String(row.month),
      revenuePaise: Number(row.revenue_paise ?? 0),
      bookingCount: Number(row.booking_count ?? 0),
      refundsPaise: Number(row.refunds_paise ?? 0),
      netEarningsPaise: Number(row.revenue_paise ?? 0) - Number(row.refunds_paise ?? 0),
      commissionPaise: Number(row.commission_paise ?? 0),
      platformFeesPaise: Number(row.platform_fees_paise ?? 0),
      growthMoM_pct: row.growth_mom_pct !== null ? Number(row.growth_mom_pct) : null,
      growthYoY_pct: row.growth_yoy_pct !== null ? Number(row.growth_yoy_pct) : null,
    }));

    // ── 4. Resource performance ───────────────────────────────────────────────
    const resources = await pool.query(
      `SELECT
         tr.id AS resource_id,
         tr.name AS resource_name,
         tr.category,
         tv.name AS venue_name,
         COUNT(tb.id) AS booking_count,
         COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise,
         CASE WHEN COUNT(tb.id) > 0 THEN ROUND(SUM(tb.amount) / COUNT(tb.id)) ELSE 0 END AS avg_booking_paise,
         COALESCE(AVG(trev.rating), 0) AS rating
       FROM turf_resources tr
       JOIN turf_venues tv ON tv.id = tr.venue_id
       LEFT JOIN turf_bookings tb ON tb.resource_id = tr.id AND tb.organization_id = $1
         AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
       LEFT JOIN turf_reviews trev ON trev.resource_id = tr.id
       WHERE tv.organization_id = $1 AND tr.deleted_at IS NULL
       GROUP BY tr.id, tr.name, tr.category, tv.name
       ORDER BY revenue_paise DESC`,
      [orgId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
    );

    const resourceRows = resources.rows.map((row: Record<string, unknown>) => ({
      resourceId: Number(row.resource_id),
      resourceName: String(row.resource_name),
      category: String(row.category),
      venueName: String(row.venue_name),
      bookingCount: Number(row.booking_count ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
      avgBookingValuePaise: Number(row.avg_booking_paise ?? 0),
      utilization_pct: 0,
      rating: Number(row.rating ?? 0),
    }));

    // Compute utilization per resource
    for (const res of resourceRows) {
      const util = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('confirmed','completed'))::numeric / NULLIF(COUNT(*), 0) * 100 AS util_pct
         FROM turf_availability_units tau
         JOIN turf_bookings tb ON tb.availability_unit_id = tau.id
         WHERE tau.resource_id = $1
           AND tb.organization_id = $2
           AND tau.starts_at >= $3::timestamptz
           AND tau.ends_at < $4::timestamptz`,
        [res.resourceId, orgId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
      );
      const utilRow = util.rows[0] as Record<string, string | number> | undefined;
      res.utilization_pct = utilRow?.util_pct ? Number(Number(utilRow.util_pct).toFixed(1)) : 0;
    }

    const topResources = [...resourceRows].sort((a, b) => b.revenuePaise - a.revenuePaise).slice(0, 10);
    const underperforming = resourceRows.filter(r => r.bookingCount === 0 || r.utilization_pct < 20).slice(0, 10);

    // ── 5. Peak booking slots ─────────────────────────────────────────────────
    const peakSlots = await pool.query(
      `SELECT
         EXTRACT(DOW FROM tb.created_at)::int AS day_of_week,
         EXTRACT(HOUR FROM tb.created_at)::int AS hour,
         COUNT(*) AS booking_count,
         COALESCE(SUM(tb.amount), 0)::bigint AS revenue_paise
       FROM turf_bookings tb
       WHERE tb.organization_id = $1 AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
       GROUP BY EXTRACT(DOW FROM tb.created_at), EXTRACT(HOUR FROM tb.created_at)
       ORDER BY booking_count DESC
       LIMIT 20`,
      [orgId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
    );

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const peakSlotRows: PeakSlot[] = peakSlots.rows.map((row: Record<string, unknown>) => ({
      dayOfWeek: Number(row.day_of_week),
      dayName: DAY_NAMES[Number(row.day_of_week)] || '',
      hour: Number(row.hour),
      bookingCount: Number(row.booking_count ?? 0),
      revenuePaise: Number(row.revenue_paise ?? 0),
    }));

    // ── 6. Low demand slots ───────────────────────────────────────────────────
    const lowDemand = await pool.query(
      `WITH available AS (
         SELECT tau.id, tau.starts_at, tau.ends_at, tau.resource_id
         FROM turf_availability_units tau
         JOIN turf_resources tr ON tr.id = tau.resource_id
         JOIN turf_venues tv ON tv.id = tr.venue_id
         WHERE tv.organization_id = $1
           AND tau.starts_at >= $2::timestamptz
           AND tau.ends_at < $3::timestamptz
           AND tau.status = 'available'
           AND tau.deleted_at IS NULL
       ),
       booked AS (
         SELECT tau.id
         FROM turf_bookings tb
         JOIN turf_availability_units tau ON tau.id = tb.availability_unit_id
         WHERE tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz
           AND tb.created_at < $3::timestamptz
           AND tb.status NOT IN ('cancelled', 'expired', 'pending_payment')
       )
       SELECT
         DATE(a.starts_at) AS date,
         EXTRACT(HOUR FROM a.starts_at)::int AS hour,
         COUNT(*)::int AS available_slots,
         COUNT(b.id)::int AS booked_slots
       FROM available a
       LEFT JOIN booked b ON b.id = a.id
       GROUP BY DATE(a.starts_at), EXTRACT(HOUR FROM a.starts_at)
       HAVING COUNT(*) > 0
       ORDER BY (COUNT(b.id)::numeric / NULLIF(COUNT(*), 0)) ASC
       LIMIT 20`,
      [orgId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
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

    // ── 7. Customer segments ──────────────────────────────────────────────────
    const customerSegments = await pool.query(
      `WITH customer_stats AS (
         SELECT
           u.id AS user_id,
           COUNT(DISTINCT tb.id) FILTER (WHERE tb.organization_id = $1) AS booking_count,
           COALESCE(SUM(tb.amount) FILTER (WHERE tb.organization_id = $1), 0)::bigint AS total_spend
         FROM users u
         JOIN turf_bookings tb ON tb.user_id = u.id AND tb.organization_id = $1
           AND tb.created_at >= $2::timestamptz AND tb.created_at < $3::timestamptz
           AND tb.status NOT IN ('cancelled', 'expired', 'pending_payment')
         GROUP BY u.id
       )
       SELECT
         COUNT(*) FILTER (WHERE booking_count = 1) AS new_customers,
         COUNT(*) FILTER (WHERE booking_count > 1) AS returning_customers,
         COALESCE(SUM(total_spend) FILTER (WHERE booking_count = 1), 0)::bigint AS new_revenue,
         COALESCE(SUM(total_spend) FILTER (WHERE booking_count > 1), 0)::bigint AS returning_revenue,
         COALESCE(SUM(total_spend), 0)::bigint AS total_revenue
       FROM customer_stats`,
      [orgId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
    );

    const cs = (customerSegments.rows[0] as Record<string, string | number>) ?? {};
    const customerSeg: CustomerSegment = {
      newCustomers: Number(cs.new_customers ?? 0),
      returningCustomers: Number(cs.returning_customers ?? 0),
      totalRevenuePaise: Number(cs.total_revenue ?? 0),
      newCustomerRevenuePaise: Number(cs.new_revenue ?? 0),
      returningCustomerRevenuePaise: Number(cs.returning_revenue ?? 0),
    };

    // ── 8. Insights ───────────────────────────────────────────────────────────
    const insights = this.generateInsights({
      revenueSummary,
      monthly: monthlyPoints,
      resources: resourceRows,
      peakSlots: peakSlotRows,
      lowDemandSlots: lowDemandRows,
      customerSegments: customerSeg,
    });

    return {
      summary: revenueSummary,
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
   * Settlement history for the organization.
   */
  async getSettlementHistory(orgId: number, limit = 50): Promise<
    Array<{
      id: number;
      status: string;
      gross_amount: number;
      commission_amount: number;
      tax_amount: number;
      net_amount: number;
      gateway_payout_id: string | null;
      scheduled_at: string;
      completed_at: string | null;
      created_at: string;
    }>
  > {
    const { rows } = await getPool().query(
      `SELECT id, status, gross_amount, commission_amount, tax_amount, net_amount,
              gateway_payout_id, scheduled_at, completed_at, created_at
       FROM turf_settlements
       WHERE organization_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [orgId, limit]
    );
    return (rows as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.id),
      status: String(row.status),
      gross_amount: Number(row.gross_amount ?? 0),
      commission_amount: Number(row.commission_amount ?? 0),
      tax_amount: Number(row.tax_amount ?? 0),
      net_amount: Number(row.net_amount ?? 0),
      gateway_payout_id: row.gateway_payout_id ? String(row.gateway_payout_id) : null,
      scheduled_at: String(row.scheduled_at),
      completed_at: row.completed_at ? String(row.completed_at) : null,
      created_at: String(row.created_at),
    }));
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private generateInsights(data: {
    revenueSummary: RevenueSummary;
    monthly: MonthlyRevenuePoint[];
    resources: ResourcePerformance[];
    peakSlots: PeakSlot[];
    lowDemandSlots: LowDemandSlot[];
    customerSegments: CustomerSegment;
  }): string[] {
    const insights: string[] = [];

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
    if (data.revenueSummary.avgBookingValuePaise > 0) {
      insights.push(`Average booking value: ₹${(data.revenueSummary.avgBookingValuePaise / 100).toFixed(2)}. Small upsells or bundles could increase this.`);
    }

    // Refund rate
    if (data.revenueSummary.bookingCount > 0) {
      const refundRate = (data.revenueSummary.refundedCount / data.revenueSummary.bookingCount) * 100;
      if (refundRate > 15) {
        insights.push(`Refund rate is ${refundRate.toFixed(1)}% — above healthy threshold. Review cancellation policies and customer expectations.`);
      }
    }

    return insights;
  }
}

export const ownerDashboardService = new OwnerDashboardService();
