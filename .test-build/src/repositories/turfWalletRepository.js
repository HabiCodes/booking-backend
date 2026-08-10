"use strict";
/**
 * Turf wallet transaction repository.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.turfWalletRepository = exports.TurfWalletRepository = void 0;
const pool_1 = require("../db/pool");
class TurfWalletRepository {
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO turf_wallet_transactions (user_id, organization_id, coins, balance_after, type, category, booking_id, description, actor_type, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [input.user_id, input.organization_id, input.coins, input.balance_after, input.type, input.category ?? null, input.booking_id ?? null, input.description ?? null, input.actor_type ?? null, input.actor_id ?? null]);
        return rows[0];
    }
    async getBalance(userId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT COALESCE(SUM(coins), 0) as balance FROM turf_wallet_transactions WHERE user_id = $1', [userId]);
        return Number(rows[0].balance) || 0;
    }
    async findByUser(userId, limit = 50, offset = 0) {
        const { rows: countRows } = await (0, pool_1.getPool)().query('SELECT COUNT(*) FROM turf_wallet_transactions WHERE user_id = $1', [userId]);
        const total = Number(countRows[0]?.count ?? 0);
        const { rows } = await (0, pool_1.getPool)().query('SELECT id, user_id, organization_id, coins, balance_after, type, category, booking_id, description, actor_type, actor_id, created_at FROM turf_wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
        return { items: rows, total };
    }
}
exports.TurfWalletRepository = TurfWalletRepository;
exports.turfWalletRepository = new TurfWalletRepository();
