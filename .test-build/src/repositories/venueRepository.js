"use strict";
/**
 * Venue repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.venueRepository = exports.VenueRepository = void 0;
const pool_1 = require("../db/pool");
class VenueRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM venues WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByOrganization(organizationId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM venues WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [organizationId]);
        return rows;
    }
    async findAll(query) {
        const page = query.page || 1;
        const pageSize = Math.min(query.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const whereClauses = ['deleted_at IS NULL'];
        const params = [];
        let idx = 1;
        if (query.organizationId) {
            whereClauses.push(`organization_id = $${idx++}`);
            params.push(query.organizationId);
        }
        if (query.isActive !== undefined) {
            whereClauses.push(`is_active = $${idx++}`);
            params.push(query.isActive);
        }
        if (query.search) {
            params.push(`%${query.search}%`, `%${query.search}%`);
            whereClauses.push(`(name ILIKE $${idx++} OR city ILIKE $${idx - 1})`);
        }
        const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM venues ${where}`, params);
        const total = Number(countRows[0]?.total ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, organization_id, name, address, city, state, country, latitude, longitude, capacity, notes, is_active, created_at, updated_at FROM venues ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return { items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO venues (organization_id, name, address, city, state, country, latitude, longitude, capacity, seating_map, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [input.organization_id, input.name, input.address ?? null, input.city ?? null, input.state ?? null, input.country ?? null, input.latitude ?? null, input.longitude ?? null, input.capacity ?? null, JSON.stringify(input.seating_map || {}), input.notes ?? null]);
        return rows[0];
    }
    async update(id, input) {
        const fields = [];
        const params = [];
        let idx = 1;
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx++}`);
                params.push(key === 'seating_map' ? JSON.stringify(value) : value);
            }
        }
        if (fields.length === 0)
            return this.findById(id);
        params.push(id);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE venues SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        return rows[0] || null;
    }
    async softDelete(id) {
        await (0, pool_1.getPool)().query('UPDATE venues SET deleted_at = NOW() WHERE id = $1', [id]);
    }
}
exports.VenueRepository = VenueRepository;
exports.venueRepository = new VenueRepository();
