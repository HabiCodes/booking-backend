/**
 * Turf wallet transaction repository.
 */

import { getPool } from '../db/pool';
import type { TurfWalletTransactionRow, TurfWalletTransactionPublic } from '../types';

export class TurfWalletRepository {
  async create(input: Record<string, unknown>): Promise<TurfWalletTransactionRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_wallet_transactions (user_id, organization_id, coins, balance_after, type, category, booking_id, description, actor_type, actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [input.user_id, input.organization_id, input.coins, input.balance_after, input.type, input.category ?? null, input.booking_id ?? null, input.description ?? null, input.actor_type ?? null, input.actor_id ?? null]
    );
    return rows[0] as TurfWalletTransactionRow;
  }

  async getBalance(userId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COALESCE(SUM(coins), 0) as balance FROM turf_wallet_transactions WHERE user_id = $1',
      [userId]
    );
    return Number((rows[0] as any).balance) || 0;
  }

  async findByUser(userId: number, limit = 50, offset = 0): Promise<{ items: TurfWalletTransactionPublic[]; total: number }> {
    const { rows: countRows } = await getPool().query(
      'SELECT COUNT(*) FROM turf_wallet_transactions WHERE user_id = $1',
      [userId]
    );
    const total = Number((countRows as Array<{ count: string | number }>)[0]?.count ?? 0);
    const { rows } = await getPool().query(
      'SELECT id, user_id, organization_id, coins, balance_after, type, category, booking_id, description, actor_type, actor_id, created_at FROM turf_wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    return { items: rows as TurfWalletTransactionPublic[], total };
  }
}

export const turfWalletRepository = new TurfWalletRepository();
