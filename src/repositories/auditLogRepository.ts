/**
 * Audit log repository — queries the `audit_logs` table.
 */

import { getPool } from '../db/pool';
import type { AuditLogRow } from '../types';

export interface AuditLogQuery {
  adminId?: number;
  action?: string;
  entityType?: string;
  entityId?: number;
  organizationId?: number | null;
  limit?: number;
  offset?: number;
}

export class AuditLogRepository {
  async findAll(query: AuditLogQuery = {}): Promise<{ items: AuditLogRow[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (query.adminId !== undefined) {
      conditions.push(`al.admin_id = $${idx++}`);
      params.push(query.adminId);
    }
    if (query.action) {
      conditions.push(`al.action ILIKE $${idx++}`);
      params.push(`%${query.action}%`);
    }
    if (query.entityType) {
      conditions.push(`al.entity_type = $${idx++}`);
      params.push(query.entityType);
    }
    if (query.entityId !== undefined) {
      conditions.push(`al.entity_id = $${idx++}`);
      params.push(query.entityId);
    }
    // Org-scoping: filter audit logs to admins in the same organization
    if (query.organizationId !== undefined && query.organizationId !== null) {
      conditions.push(`al.admin_id IN (SELECT id FROM admins WHERE organization_id = $${idx++})`);
      params.push(query.organizationId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows, rowCount } = await getPool().query(
      `SELECT al.id, al.admin_id, al.action, al.entity_type, al.entity_id, al.metadata, al.ip_address, al.user_agent, al.created_at
       FROM audit_logs al
       ${whereClause}
       ORDER BY al.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, query.limit ?? 50, query.offset ?? 0]
    );

    const totalRow = await getPool().query(
      `SELECT COUNT(*) as total FROM audit_logs al ${whereClause}`,
      params
    );

    return {
      items: rows as unknown as AuditLogRow[],
      total: Number((totalRow.rows as Array<{ total: number | string }>)[0]?.total ?? 0),
    };
  }

  async insert(params: {
    adminId: number | null;
    action: string;
    entityType?: string | null;
    entityId?: number | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          params.adminId,
          params.action,
          params.entityType ?? null,
          params.entityId ?? null,
          JSON.stringify(params.metadata ?? {}),
          params.ipAddress ?? null,
          params.userAgent ?? null,
        ]
      );
    } catch (err) {
      // Audit failures must never break the request path. Log via Winston and continue.
      // eslint-disable-next-line no-console
      console.warn('audit_logs insert failed:', (err as Error).message);
    }
  }
}

export const auditLogRepository = new AuditLogRepository();
