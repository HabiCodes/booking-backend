"use strict";
/**
 * Audit log repository — queries the `audit_logs` table.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLogRepository = exports.AuditLogRepository = void 0;
const pool_1 = require("../db/pool");
class AuditLogRepository {
    async findAll(query = {}) {
        const conditions = [];
        const params = [];
        let idx = 1;
        if (query.adminId !== undefined) {
            conditions.push(`admin_id = $${idx++}`);
            params.push(query.adminId);
        }
        if (query.action) {
            conditions.push(`action ILIKE $${idx++}`);
            params.push(`%${query.action}%`);
        }
        if (query.entityType) {
            conditions.push(`entity_type = $${idx++}`);
            params.push(query.entityType);
        }
        if (query.entityId !== undefined) {
            conditions.push(`entity_id = $${idx++}`);
            params.push(query.entityId);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const { rows, rowCount } = await (0, pool_1.getPool)().query(`SELECT id, admin_id, action, entity_type, entity_id, metadata, ip_address, user_agent, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`, [...params, query.limit ?? 50, query.offset ?? 0]);
        const totalRow = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM audit_logs ${whereClause}`, params);
        return {
            items: rows,
            total: Number(totalRow.rows[0]?.total ?? 0),
        };
    }
    async insert(params) {
        try {
            await (0, pool_1.getPool)().query(`INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [
                params.adminId,
                params.action,
                params.entityType ?? null,
                params.entityId ?? null,
                JSON.stringify(params.metadata ?? {}),
                params.ipAddress ?? null,
                params.userAgent ?? null,
            ]);
        }
        catch (err) {
            // Audit failures must never break the request path. Log via Winston and continue.
            // eslint-disable-next-line no-console
            console.warn('audit_logs insert failed:', err.message);
        }
    }
}
exports.AuditLogRepository = AuditLogRepository;
exports.auditLogRepository = new AuditLogRepository();
