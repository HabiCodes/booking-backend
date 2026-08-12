"use strict";
/**
 * Organizer user repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerUserRepository = exports.OrganizerUserRepository = void 0;
const pool_1 = require("../db/pool");
const crypto_1 = require("../utils/crypto");
class OrganizerUserRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM organizer_users WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByEmail(email) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM organizer_users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
        return rows[0] || null;
    }
    async findByOrganization(organizationId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM organizer_users WHERE organization_id = $1 ORDER BY role DESC, created_at ASC', [organizationId]);
        return rows;
    }
    async listAll(query) {
        const page = query.page || 1;
        const pageSize = Math.min(query.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const whereClauses = [];
        const params = [];
        let idx = 1;
        if (query.organizationId) {
            whereClauses.push(`organization_id = $${idx++}`);
            params.push(query.organizationId);
        }
        if (query.role) {
            whereClauses.push(`role = $${idx++}`);
            params.push(query.role);
        }
        if (query.search) {
            params.push(`%${query.search}%`, `%${query.search}%`);
            whereClauses.push(`(email ILIKE $${idx++} OR name ILIKE $${idx - 1})`);
        }
        const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM organizer_users ${where}`, params);
        const total = Number(countRows[0]?.total ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, organization_id, email, name, phone, role, permissions, is_active, must_change_password, last_login_at, created_at, updated_at FROM organizer_users ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return { items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    async create(input) {
        const passwordHash = await (0, crypto_1.hashPassword)(input.password);
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO organizer_users (organization_id, email, password_hash, name, phone, role, permissions, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`, [input.organization_id, input.email.toLowerCase().trim(), passwordHash, input.name, input.phone ?? null, input.role, JSON.stringify(input.permissions || {})]);
        return rows[0];
    }
    async update(id, input) {
        const fields = [];
        const params = [];
        let idx = 1;
        if (input.email !== undefined) {
            fields.push(`email = $${idx++}`);
            params.push(input.email);
        }
        if (input.name !== undefined) {
            fields.push(`name = $${idx++}`);
            params.push(input.name);
        }
        if (input.phone !== undefined) {
            fields.push(`phone = $${idx++}`);
            params.push(input.phone);
        }
        if (input.role !== undefined) {
            fields.push(`role = $${idx++}`);
            params.push(input.role);
        }
        if (input.permissions !== undefined) {
            fields.push(`permissions = $${idx++}`);
            params.push(JSON.stringify(input.permissions));
        }
        if (input.is_active !== undefined) {
            fields.push(`is_active = $${idx++}`);
            params.push(input.is_active);
        }
        if (fields.length === 0)
            return this.findById(id);
        params.push(id);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE organizer_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        return rows[0] || null;
    }
    async setPassword(id, passwordHash, mustChange = false) {
        await (0, pool_1.getPool)().query('UPDATE organizer_users SET password_hash = $2, must_change_password = $3 WHERE id = $1', [id, passwordHash, mustChange]);
    }
    async updateLastLogin(id) {
        await (0, pool_1.getPool)().query('UPDATE organizer_users SET last_login_at = NOW() WHERE id = $1', [id]);
    }
    async verifyPassword(user, password) {
        return (0, crypto_1.comparePassword)(password, user.password_hash);
    }
    async delete(id) {
        await (0, pool_1.getPool)().query('DELETE FROM organizer_users WHERE id = $1', [id]);
    }
    async anonymize(id) {
        await (0, pool_1.getPool)().query(`UPDATE organizer_users SET name = $1, email = $2, phone = NULL, is_active = false, password_hash = 'deleted' WHERE id = $3`, [`[deleted-${id}]`, `deleted-${id}@removed.local`, id]);
    }
}
exports.OrganizerUserRepository = OrganizerUserRepository;
exports.organizerUserRepository = new OrganizerUserRepository();
