/**
 * Check-in repository — read-only analytics for scan/check-in activity.
 */

import { getPool } from '../db/pool';
import type { CheckInRow, CheckInRecord } from '../types';

export class CheckInRepository {
  async findByEvent(eventId: number, query: { fromDate?: string; toDate?: string; page?: number; pageSize?: number }): Promise<{
    items: CheckInRecord[]; total: number; page: number; pageSize: number; totalPages: number;
  }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = ['ci.event_id = $1'];
    const params: unknown[] = [eventId];
    let idx = 2;
    if (query.fromDate) { whereClauses.push(`ci.created_at >= $${idx++}`); params.push(query.fromDate); }
    if (query.toDate) { whereClauses.push(`ci.created_at <= $${idx++}`); params.push(query.toDate); }
    const where = whereClauses.join(' AND ');
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) as total FROM check_ins ci WHERE ${where}`, params);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT ci.*, t.ticket_uuid, e.title as event_title, t.attendee_name, ou.name as scanner_name FROM check_ins ci INNER JOIN tickets t ON t.id = ci.ticket_id INNER JOIN events e ON e.id = ci.event_id LEFT JOIN organizer_users ou ON ou.id = ci.scanned_by WHERE ${where} ORDER BY ci.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as CheckInRecord[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async getSummary(eventId: number, query: { fromDate?: string; toDate?: string }): Promise<{
    total_scans: number; valid_scans: number; duplicate_scans: number; invalid_scans: number; expired_scans: number; cancelled_scans: number;
    by_manager: Array<{ user_id: number; user_name: string; scan_count: number }>;
    by_event: Array<{ event_id: number; event_title: string; scan_count: number }>;
  }> {
    const whereClauses: string[] = ['event_id = $1'];
    const params: unknown[] = [eventId];
    let idx = 2;
    if (query.fromDate) { whereClauses.push(`created_at >= $${idx++}`); params.push(query.fromDate); }
    if (query.toDate) { whereClauses.push(`created_at <= $${idx++}`); params.push(query.toDate); }
    const where = whereClauses.join(' AND ');
    const { rows: summaryRows } = await getPool().query(
      `SELECT COUNT(*) as total_scans, COUNT(*) FILTER (WHERE status = 'VALID') as valid_scans, COUNT(*) FILTER (WHERE status = 'ALREADY_SCANNED') as duplicate_scans, COUNT(*) FILTER (WHERE status = 'INVALID') as invalid_scans, COUNT(*) FILTER (WHERE status = 'EXPIRED') as expired_scans, COUNT(*) FILTER (WHERE status = 'CANCELLED') as cancelled_scans FROM check_ins WHERE ${where}`,
      params
    );
    const summary = (summaryRows as Array<Record<string, number | string>>)[0];
    const { rows: managerRows } = await getPool().query(
      `SELECT ci.scanned_by as user_id, ou.name as user_name, COUNT(*) as scan_count FROM check_ins ci LEFT JOIN organizer_users ou ON ou.id = ci.scanned_by WHERE ${where} GROUP BY ci.scanned_by, ou.name ORDER BY scan_count DESC`,
      params
    );
    return {
      total_scans: Number(summary?.total_scans ?? 0), valid_scans: Number(summary?.valid_scans ?? 0), duplicate_scans: Number(summary?.duplicate_scans ?? 0), invalid_scans: Number(summary?.invalid_scans ?? 0), expired_scans: Number(summary?.expired_scans ?? 0), cancelled_scans: Number(summary?.cancelled_scans ?? 0),
      by_manager: managerRows as Array<{ user_id: number; user_name: string; scan_count: number }>,
      by_event: [],
    };
  }

  async create(data: { ticket_id: number; event_id: number; scanned_by: number; status: string; metadata?: Record<string, unknown> }): Promise<CheckInRow> {
    const { rows } = await getPool().query(
      `INSERT INTO check_ins (ticket_id, event_id, scanned_by, status, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.ticket_id, data.event_id, data.scanned_by, data.status, JSON.stringify(data.metadata || {})]
    );
    return (rows as unknown as CheckInRow[])[0];
  }
}

export const checkInRepository = new CheckInRepository();
