"use strict";
/**
 * Organizer application repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerAppRepository = exports.OrganizerAppRepository = void 0;
const pool_1 = require("../db/pool");
class OrganizerAppRepository {
    async findAll(query) {
        const page = query.page || 1;
        const pageSize = Math.min(query.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const whereClauses = [];
        const params = [];
        let idx = 1;
        if (query.status) {
            whereClauses.push(`status = $${idx++}`);
            params.push(query.status);
        }
        if (query.search) {
            params.push(`%${query.search}%`, `%${query.search}%`, `%${query.search}%`);
            whereClauses.push(`(legal_name ILIKE $${idx++} OR display_name ILIKE $${idx++} OR email ILIKE $${idx - 3})`);
        }
        const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM organizer_applications ${where}`, params);
        const total = Number(countRows[0]?.total ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, legal_name, display_name, email, phone, city, state, country, status, rejection_type, rejection_reason, submitted_at, created_at, reviewed_at FROM organizer_applications ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return { items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM organizer_applications WHERE id = $1 LIMIT 1`, [id]);
        return rows[0] || null;
    }
    async findByEmail(email) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM organizer_applications WHERE LOWER(email) = LOWER($1) LIMIT 1`, [email]);
        return rows[0] || null;
    }
    async findByIdentityDocumentUrl(url) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM organizer_applications WHERE identity_document_url = $1 LIMIT 1`, [url]);
        return rows[0] || null;
    }
    async findWithHistory(id) {
        const appRow = await this.findById(id);
        if (!appRow)
            return null;
        const { rows: historyRows } = await (0, pool_1.getPool)().query(`SELECT h.*, a.name AS actor_name FROM organizer_application_history h LEFT JOIN admins a ON a.id = h.actor_admin_id WHERE h.application_id = $1 ORDER BY h.created_at DESC`, [id]);
        return { application: appRow, history: historyRows };
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO organizer_applications (legal_name, display_name, email, phone, business_address, city, state, country, gst_tax_id, pan, identity_document_url, business_document_url, supporting_document_urls, account_holder_name, bank_details, payout_details, logo_url, description, branding_metadata, status, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending',NOW()) RETURNING *`, [input.legal_name, input.display_name, input.email, input.phone ?? null, input.business_address ?? null, input.city ?? null, input.state ?? null, input.country ?? 'India', input.gst_tax_id ?? null, input.pan ?? null, input.identity_document_url ?? null, input.business_document_url ?? null, JSON.stringify(input.supporting_document_urls || []), input.account_holder_name ?? null, JSON.stringify(input.bank_details || {}), JSON.stringify(input.payout_details || {}), input.logo_url ?? null, input.description ?? null, JSON.stringify(input.branding_metadata || {})]);
        return rows[0];
    }
    async approve(id, reviewedBy) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), rejection_type = NULL, rejection_reason = NULL WHERE id = $1 RETURNING *`, [id, reviewedBy]);
        return rows[0];
    }
    async softReject(id, reviewedBy, reason) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET status = 'soft_rejected', rejection_type = 'soft', rejection_reason = $3, reviewed_by = $2, reviewed_at = NOW() WHERE id = $1 RETURNING *`, [id, reviewedBy, reason]);
        return rows[0];
    }
    async hardReject(id, reviewedBy, reason) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET status = 'hard_rejected', rejection_type = 'hard', rejection_reason = $3, hard_rejected_by = $2, hard_rejected_at = NOW(), reviewed_by = $2, reviewed_at = NOW() WHERE id = $1 RETURNING *`, [id, reviewedBy, reason]);
        return rows[0];
    }
    async reopen(id, reviewedBy) {
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET status = 'pending', rejection_type = NULL, rejection_reason = NULL, reviewed_by = NULL, reviewed_at = NULL, hard_rejected_by = NULL, hard_rejected_at = NULL WHERE id = $1 RETURNING *`, [id, reviewedBy]);
        return rows[0];
    }
    async linkOrganization(id, organizationId) {
        await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET organization_id = $2 WHERE id = $1`, [id, organizationId]);
    }
    async findByOrganizationId(organizationId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM organizer_applications WHERE organization_id = $1 AND status NOT IN ('approved', 'hard_rejected') ORDER BY created_at DESC LIMIT 1`, [organizationId]);
        return rows[0] || null;
    }
    async addHistoryEntry(input) {
        await (0, pool_1.getPool)().query(`INSERT INTO organizer_application_history (application_id, from_status, to_status, reason, actor_admin_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)`, [input.applicationId, input.fromStatus, input.toStatus, input.reason ?? null, input.actorAdminId ?? null, JSON.stringify(input.metadata || {})]);
    }
    async update(id, data) {
        const keys = Object.keys(data).filter(k => k !== 'id' && data[k] !== undefined);
        if (keys.length === 0) {
            const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM organizer_applications WHERE id = $1 LIMIT 1', [id]);
            return rows[0];
        }
        const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const values = keys.map(k => data[k]);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_applications SET ${setClause} WHERE id = $1 RETURNING *`, [id, ...values]);
        return rows[0];
    }
    async addHistory(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO organizer_application_history (application_id, from_status, to_status, reason, actor_admin_id, metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [input.applicationId, input.from_status, input.to_status, input.reason ?? null, input.actor_admin_id ?? null, JSON.stringify(input.metadata || {})]);
        return rows[0];
    }
}
exports.OrganizerAppRepository = OrganizerAppRepository;
exports.organizerAppRepository = new OrganizerAppRepository();
