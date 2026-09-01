/**
 * ManagerAnalyticsService — QR scan analytics and manager performance.
 */

import { getPool } from '../db/pool';

export interface ManagerStats {
  managerId: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  assignedVenues: number[];
  totalScans: number;
  validScans: number;
  duplicateScans: number;
  invalidScans: number;
  expiredScans: number;
  successRate_pct: number;
  todayScans: number;
  weekScans: number;
  monthScans: number;
  lastScanAt: string | null;
}

export interface ScanTrendPoint {
  date: string;
  totalScans: number;
  validScans: number;
  invalidScans: number;
}

export interface ManagerComparison {
  managerId: number;
  name: string;
  totalScans: number;
  validScans: number;
  successRate_pct: number;
  todayScans: number;
  lastScanAt: string | null;
  rank: number;
}

export interface RecentScan {
  id: number;
  ticketUuid: string;
  eventTitle: string;
  attendeeName: string;
  status: string;
  managerName: string;
  createdAt: string;
}

export interface ManagerAnalyticsResponse {
  managers: ManagerStats[];
  scanTrends: ScanTrendPoint[];
  comparison: ManagerComparison[];
  recentScans: RecentScan[];
  insights: string[];
}

export class ManagerAnalyticsService {
  async getManagerAnalytics(orgId: number, range?: { from?: string; to?: string }): Promise<ManagerAnalyticsResponse> {
    const pool = getPool();

    // Calendar-aware UTC boundaries (NOT T23:59:59 — that excludes the last second).
    // "Today" end = next day at 00:00:00 UTC (half-open upper bound).
    const todayUtc = new Date();
    const todayStr = todayUtc.toISOString().slice(0, 10);
    const from = range?.from ?? todayStr;
    const to = range?.to ?? todayStr;

    // Compute exclusive upper bound = next day after "to"
    const toExclusiveDate = new Date(to + 'T00:00:00Z');
    toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
    const toExclusive = toExclusiveDate.toISOString().slice(0, 19) + 'Z';

    const fromTs = from + 'T00:00:00Z';

    // Week-ago: 7 days ago from "now" (timestamp)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Today (UTC midnight to now)
    const todayStart = todayStr + 'T00:00:00Z';

    const managersQuery = await pool.query(
      `SELECT
         ou.id AS manager_id, ou.name, ou.email, ou.role, ou.is_active,
         ou.last_login_at, ou.created_at, ou.assigned_venue_ids,
         COUNT(ci.id) AS total_scans,
         COUNT(ci.id) FILTER (WHERE ci.status = 'VALID') AS valid_scans,
         COUNT(ci.id) FILTER (WHERE ci.status = 'ALREADY_SCANNED') AS duplicate_scans,
         COUNT(ci.id) FILTER (WHERE ci.status IN ('INVALID','WRONG_EVENT')) AS invalid_scans,
         COUNT(ci.id) FILTER (WHERE ci.status = 'EXPIRED') AS expired_scans,
         COUNT(ci.id) FILTER (WHERE ci.created_at >= $2::timestamptz AND ci.created_at < $3::timestamptz) AS today_scans,
         COUNT(ci.id) FILTER (WHERE ci.created_at >= $4::timestamptz AND ci.created_at < $3::timestamptz) AS week_scans,
         COUNT(ci.id) FILTER (WHERE ci.created_at >= DATE_TRUNC('month', $3::timestamptz) AND ci.created_at < $3::timestamptz) AS month_scans,
         MAX(ci.created_at) AS last_scan_at
       FROM organizer_users ou
       LEFT JOIN check_ins ci ON ci.scanned_by = ou.id AND ci.created_at >= $4::timestamptz AND ci.created_at < $3::timestamptz
       WHERE ou.organization_id = $1 AND ou.role = 'manager'
       GROUP BY ou.id, ou.name, ou.email, ou.role, ou.is_active, ou.last_login_at, ou.created_at, ou.assigned_venue_ids
       ORDER BY total_scans DESC`,
      [orgId, fromTs, toExclusive, weekAgo]
    );

    const managers: ManagerStats[] = managersQuery.rows.map((row: Record<string, unknown>) => {
      const totalScans = Number(row.total_scans ?? 0);
      const validScans = Number(row.valid_scans ?? 0);
      return {
        managerId: Number(row.manager_id),
        name: String(row.name),
        email: String(row.email),
        role: String(row.role),
        isActive: Boolean(row.is_active),
        lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
        createdAt: String(row.created_at),
        assignedVenues: Array.isArray(row.assigned_venue_ids)
          ? row.assigned_venue_ids.map((v: unknown) => Number(v))
          : [],
        totalScans,
        validScans,
        duplicateScans: Number(row.duplicate_scans ?? 0),
        invalidScans: Number(row.invalid_scans ?? 0),
        expiredScans: Number(row.expired_scans ?? 0),
        successRate_pct: totalScans > 0 ? Number(((validScans / totalScans) * 100).toFixed(1)) : 0,
        todayScans: Number(row.today_scans ?? 0),
        weekScans: Number(row.week_scans ?? 0),
        monthScans: Number(row.month_scans ?? 0),
        lastScanAt: row.last_scan_at ? String(row.last_scan_at) : null,
      };
    });

    const trendsQuery = await pool.query(
      `SELECT DATE(ci.created_at) AS date,
              COUNT(*) AS total_scans,
              COUNT(*) FILTER (WHERE ci.status = 'VALID') AS valid_scans,
              COUNT(*) FILTER (WHERE ci.status IN ('INVALID','WRONG_EVENT','EXPIRED')) AS invalid_scans
       FROM check_ins ci
       JOIN organizer_users ou ON ou.id = ci.scanned_by
       WHERE ou.organization_id = $1
         AND ci.created_at >= $2::timestamptz AND ci.created_at < $3::timestamptz
       GROUP BY DATE(ci.created_at) ORDER BY date`,
      [orgId, fromTs, toExclusive]
    );

    const scanTrends: ScanTrendPoint[] = trendsQuery.rows.map((row: Record<string, unknown>) => ({
      date: String(row.date),
      totalScans: Number(row.total_scans ?? 0),
      validScans: Number(row.valid_scans ?? 0),
      invalidScans: Number(row.invalid_scans ?? 0),
    }));

    const ranked = [...managers]
      .filter(m => m.totalScans > 0)
      .sort((a, b) => b.totalScans - a.totalScans);

    const comparison: ManagerComparison[] = ranked.map((m, i) => ({
      managerId: m.managerId,
      name: m.name,
      totalScans: m.totalScans,
      validScans: m.validScans,
      successRate_pct: m.successRate_pct,
      todayScans: m.todayScans,
      lastScanAt: m.lastScanAt,
      rank: i + 1,
    }));

    const recentQuery = await pool.query(
      `SELECT ci.id, t.ticket_uuid, e.title AS event_title,
              t.attendee_name, ci.status, ou.name AS manager_name, ci.created_at
       FROM check_ins ci
       JOIN organizer_users ou ON ou.id = ci.scanned_by
       JOIN tickets t ON t.id = ci.ticket_id
       JOIN events e ON e.id = ci.event_id
       WHERE ou.organization_id = $1
       ORDER BY ci.created_at DESC LIMIT 50`,
      [orgId]
    );

    const recentScans: RecentScan[] = recentQuery.rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      ticketUuid: String(row.ticket_uuid),
      eventTitle: String(row.event_title),
      attendeeName: String(row.attendee_name),
      status: String(row.status),
      managerName: String(row.manager_name),
      createdAt: String(row.created_at),
    }));

    const insights = this.generateInsights(managers, scanTrends, comparison);

    return { managers, scanTrends, comparison, recentScans, insights };
  }

  private generateInsights(
    managers: ManagerStats[],
    trends: ScanTrendPoint[],
    comparison: ManagerComparison[]
  ): string[] {
    const insights: string[] = [];

    const inactive = managers.filter(m => !m.isActive);
    if (inactive.length > 0) {
      insights.push(`${inactive.length} manager(s) currently deactivated. Ensure handover coverage for their assigned venues.`);
    }

    const lowActivity = managers.filter(m => m.isActive && m.monthScans === 0);
    if (lowActivity.length > 0) {
      insights.push(`${lowActivity.length} active manager(s) had zero scans this month — investigate whether they need retraining or reassignment.`);
    }

    if (comparison.length > 0) {
      const top = comparison[0];
      insights.push(`Top performer: ${top.name} with ${top.totalScans} scans (${top.successRate_pct}% success rate).`);
    }

    const avgSuccessRate = managers.length > 0
      ? managers.reduce((s, m) => s + m.successRate_pct, 0) / managers.length
      : 0;
    if (avgSuccessRate < 80 && managers.length > 0) {
      insights.push(`Average scan success rate is ${avgSuccessRate.toFixed(0)}% — below optimal. Review ticket quality and scanner training.`);
    }

    if (trends.length >= 2) {
      const last = trends[trends.length - 1];
      const prev = trends[trends.length - 2];
      const change = ((last.totalScans - prev.totalScans) / Math.max(prev.totalScans, 1)) * 100;
      if (change > 20) {
        insights.push(`Scan volume up ${change.toFixed(0)}% compared to previous day — possible event spike.`);
      } else if (change < -20) {
        insights.push(`Scan volume down ${Math.abs(change).toFixed(0)}% — verify event schedules and scanner availability.`);
      }
    }

    const totalDupes = managers.reduce((s, m) => s + m.duplicateScans, 0);
    if (totalDupes > 0) {
      insights.push(`${totalDupes} duplicate scan attempts detected — ensure proper check-in UX to avoid confusion.`);
    }

    return insights;
  }
}

export const managerAnalyticsService = new ManagerAnalyticsService();
