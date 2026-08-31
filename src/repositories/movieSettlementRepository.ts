/**
 * Movie settlement repository — uses the shared settlement tables
 * (turf_settlements / turf_settlement_items) with movie-specific types.
 *
 * Movie settlement items are identified by booking_id and stored
 * alongside turf settlement items in the same tables.
 */

import { getPool } from '../db/pool';
import type { MovieSettlementRow, MovieSettlementItemRow } from '../types';

export class MovieSettlementRepository {
  async findById(id: number): Promise<MovieSettlementRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_settlements WHERE id = $1 LIMIT 1', [id]
    );
    return (rows as MovieSettlementRow[])[0] || null;
  }

  async findPendingByOrg(orgId?: number): Promise<MovieSettlementRow[]> {
    const whereClause = orgId !== undefined
      ? 'organization_id = $1 AND scheduled_at <= NOW()'
      : '1=1';
    const params = orgId !== undefined ? [orgId] : [];
    const { rows } = await getPool().query(
      `SELECT * FROM turf_settlements WHERE ${whereClause} AND status = 'pending' AND net_amount >= 500 AND retry_count < max_retries AND scheduled_at <= NOW() ORDER BY scheduled_at ASC LIMIT 20`,
      params
    );
    return rows as MovieSettlementRow[];
  }

  async create(input: { organization_id: number; gross_amount?: number; commission_amount?: number; tax_amount?: number; net_amount?: number }): Promise<MovieSettlementRow> {
    const scheduledAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlements (organization_id, gross_amount, commission_amount, tax_amount, net_amount, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [input.organization_id, input.gross_amount ?? 0, input.commission_amount ?? 0, input.tax_amount ?? 0, input.net_amount ?? 0, scheduledAt]
    );
    return rows[0] as MovieSettlementRow;
  }

  async addItem(input: { settlement_id: number; booking_id: number; gross_amount: number; commission_amount: number; tax_amount: number; net_amount: number }): Promise<MovieSettlementItemRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlement_items (settlement_id, booking_id, gross_amount, commission_amount, tax_amount, net_amount)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (booking_id) DO NOTHING RETURNING *`,
      [input.settlement_id, input.booking_id, input.gross_amount, input.commission_amount, input.tax_amount, input.net_amount]
    );
    return (rows as MovieSettlementItemRow[])[0] || null as unknown as MovieSettlementItemRow;
  }

  async findItemByBooking(bookingId: number): Promise<MovieSettlementItemRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM turf_settlement_items WHERE booking_id = $1 LIMIT 1',
      [bookingId]
    );
    return (rows as MovieSettlementItemRow[])[0] || null;
  }

  async findOrCreatePendingSettlement(orgId: number): Promise<MovieSettlementRow> {
    const { rows } = await getPool().query(
      `INSERT INTO turf_settlements (organization_id, scheduled_at)
       VALUES ($1, $2)
       ON CONFLICT (organization_id) WHERE status = 'pending'
       DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [orgId, new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()]
    );
    return rows[0] as MovieSettlementRow;
  }

  async markCompleted(id: number, payoutId: string): Promise<void> {
    await getPool().query(
      "UPDATE turf_settlements SET status = 'completed', gateway_payout_id = $2, completed_at = NOW() WHERE id = $1",
      [id, payoutId]
    );
  }
}

export const movieSettlementRepository = new MovieSettlementRepository();
