/**
 * Refund policy repository — Super Admin configured refund slabs.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/pool';
import type {
  RefundPolicyRow,
  RefundPolicyCreateInput,
} from '../types';

type Executor = ReturnType<typeof getPool> | PoolClient;

const getExecutor = (client?: PoolClient): Executor => client ?? getPool();

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'string' ? parseFloat(v) : v;
}

export class RefundPolicyRepository {
  async findActiveSlabs(client?: PoolClient): Promise<RefundPolicyRow[]> {
    const { rows } = await getExecutor(client).query(
      `SELECT * FROM refund_policies
         WHERE is_active = true
         ORDER BY hours_before DESC`
    );
    return rows as unknown as RefundPolicyRow[];
  }

  async findMatchingSlab(
    hoursRemaining: number,
    client?: PoolClient
  ): Promise<RefundPolicyRow | null> {
    // Largest hours_before <= hoursRemaining
    const { rows } = await getExecutor(client).query(
      `SELECT * FROM refund_policies
         WHERE is_active = true
           AND hours_before <= $1
         ORDER BY hours_before DESC
         LIMIT 1`,
      [hoursRemaining]
    );
    return (rows as unknown as RefundPolicyRow[])[0] || null;
  }

  async findById(id: number, client?: PoolClient): Promise<RefundPolicyRow | null> {
    const { rows } = await getExecutor(client).query(
      `SELECT * FROM refund_policies WHERE id = $1 LIMIT 1`,
      [id]
    );
    return (rows as unknown as RefundPolicyRow[])[0] || null;
  }

  async create(input: RefundPolicyCreateInput, client?: PoolClient): Promise<RefundPolicyRow> {
    const { rows } = await getExecutor(client).query(
      `INSERT INTO refund_policies (
         scope, organization_id, version,
         hours_before, refund_percentage,
         is_active, notes, created_by_admin_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.scope ?? 'global',
        input.organization_id ?? null,
        input.version ?? 1,
        input.hours_before,
        input.refund_percentage,
        input.is_active ?? true,
        input.notes ?? null,
        input.created_by_admin_id ?? null,
      ]
    );
    return (rows as unknown as RefundPolicyRow[])[0];
  }

  /** Numeric helpers — convert pg NUMERIC strings to JS numbers */
  static hoursBefore(row: RefundPolicyRow): number {
    return num(row.hours_before);
  }

  static refundPercentage(row: RefundPolicyRow): number {
    return num(row.refund_percentage);
  }
}

const refundPolicyRepository = new RefundPolicyRepository();
export { refundPolicyRepository };
