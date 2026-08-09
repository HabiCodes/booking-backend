"use strict";
/**
 * Ticket tier repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ticketTierRepository = exports.TicketTierRepository = void 0;
const pool_1 = require("../db/pool");
class TicketTierRepository {
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM ticket_tiers WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async findByEvent(eventId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM ticket_tiers WHERE event_id = $1 ORDER BY id ASC', [eventId]);
        return rows;
    }
    async findActiveByEvent(eventId) {
        const { rows } = await (0, pool_1.getPool)().query("SELECT * FROM ticket_tiers WHERE event_id = $1 AND status = 'active' ORDER BY id ASC", [eventId]);
        return rows;
    }
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO ticket_tiers (event_id, name, description, type, price, currency, total_quantity, sale_starts_at, sale_ends_at, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.event_id, input.name, input.description ?? null, input.type || 'general', input.price, input.currency || 'INR', input.total_quantity, input.sale_starts_at ?? null, input.sale_ends_at ?? null, JSON.stringify(input.metadata || {})]);
        return rows[0];
    }
    async update(id, input) {
        const fields = [];
        const params = [];
        let idx = 1;
        const map = { name: 'name', description: 'description', price: 'price', sale_starts_at: 'sale_starts_at', sale_ends_at: 'sale_ends_at', status: 'status', metadata: 'metadata' };
        for (const [key, value] of Object.entries(input)) {
            if (value !== undefined && map[key]) {
                fields.push(`${map[key]} = $${idx++}`);
                params.push(key === 'metadata' ? JSON.stringify(value) : value);
            }
        }
        if (fields.length === 0)
            return this.findById(id);
        params.push(id);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE ticket_tiers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        return rows[0] || null;
    }
    async incrementSold(id, qty) {
        await (0, pool_1.getPool)().query('UPDATE ticket_tiers SET sold_quantity = sold_quantity + $2 WHERE id = $1', [id, qty]);
    }
    async updateStatus(id, status) {
        await (0, pool_1.getPool)().query('UPDATE ticket_tiers SET status = $2 WHERE id = $1', [id, status]);
    }
    async delete(id) {
        await (0, pool_1.getPool)().query('DELETE FROM ticket_tiers WHERE id = $1', [id]);
    }
}
exports.TicketTierRepository = TicketTierRepository;
exports.ticketTierRepository = new TicketTierRepository();
