"use strict";
/**
 * Turf venue repository — independent from event-domain venues.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfVenueRepository = exports.TurfVenueRepository = void 0;
const pool_1 = require("../db/pool");
class TurfVenueRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_venues WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByOrganization(organizationId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM turf_venues WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [organizationId]);
        return rows;
    }
    async findAll(query) {
        const page = query.page || 1;
        const pageSize = Math.min(query.pageSize || 25, 100);
        const offset = (page - 1) * pageSize;
        const where = ['tv.deleted_at IS NULL'];
        const params = [];
        let idx = 1;
        if (query.organizationId) {
            where.push(`tv.organization_id = $${idx++}`);
            params.push(query.organizationId);
        }
        if (query.city) {
            where.push(`tv.city ILIKE $${idx++}`);
            params.push(`%${query.city}%`);
        }
        if (query.status) {
            where.push(`tv.status = $${idx++}`);
            params.push(query.status);
        }
        const whereStr = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const { rows: countRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) FROM turf_venues tv ${whereStr}`, params);
        const total = Number(countRows[0]?.count ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, organization_id, name, address, city, state, country, latitude, longitude, amenities, status, is_active, created_at, updated_at FROM turf_venues tv ${whereStr} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        return { items: rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_venues (organization_id, name, description, address, city, state, country, latitude, longitude, amenities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.organization_id, input.name, input.description ?? null, input.address ?? null, input.city ?? null, input.state ?? null, input.country ?? 'India', input.latitude ?? null, input.longitude ?? null, input.amenities ?? []]);
        return rows[0];
    }
    async update(id, input) {
        const fields = [];
        const params = [];
        let idx = 1;
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined) {
                fields.push(`${key} = $${idx++}`);
                params.push(key === 'amenities' ? JSON.stringify(value) : value);
            }
        }
        if (fields.length === 0)
            return this.findById(id);
        params.push(id);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE turf_venues SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, params);
        return rows[0] || null;
    }
    async softDelete(id) {
        await (0, pool_1.getPool)().query('UPDATE turf_venues SET deleted_at = NOW() WHERE id = $1', [id]);
    }
}
exports.TurfVenueRepository = TurfVenueRepository;
exports.turfVenueRepository = new TurfVenueRepository();
