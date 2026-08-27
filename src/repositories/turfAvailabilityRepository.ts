/**
 * Turf availability repository — slot management for turf resources.
 */

import { getPool } from '../db/pool';
import type { TurfAvailabilityUnitRow, TurfAvailabilityUnitPublic } from '../types';

export class TurfAvailabilityRepository {
  async findById(id: number): Promise<TurfAvailabilityUnitRow | null> {
    const { rows } = await getPool().query('SELECT * FROM turf_availability_units WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as TurfAvailabilityUnitRow[])[0] || null;
  }

  async findByResource(resourceId: number, date: string): Promise<TurfAvailabilityUnitRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM turf_availability_units
       WHERE resource_id = $1 AND starts_at::date = $2::date
       ORDER BY starts_at ASC`,
      [resourceId, date]
    );
    return rows as unknown as TurfAvailabilityUnitRow[];
  }

  async findByResourceRange(resourceId: number, from: string, to: string): Promise<TurfAvailabilityUnitRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM turf_availability_units
       WHERE resource_id = $1 AND starts_at >= $2 AND starts_at < $3
       ORDER BY starts_at ASC`,
      [resourceId, from, to]
    );
    return rows as unknown as TurfAvailabilityUnitRow[];
  }

  async reclaimExpiredLocks(resourceId: number): Promise<void> {
    await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
       WHERE resource_id = $1 AND status = 'locked' AND lock_expires_at < NOW()`,
      [resourceId]
    );
  }

  async generateSlots(resourceId: number, date: string, startTime: string, endTime: string, slotDurationMinutes: number, price?: number): Promise<{ requested: number; created: number; skippedExisting: number }> {
    const resourceResult = await getPool().query(
      `SELECT resource_type FROM turf_resources WHERE id = $1`,
      [resourceId]
    );
    const resource = resourceResult.rows[0];
    if (!resource) throw new Error('Resource not found');
    if (resource.resource_type !== 'slot_based') {
      throw new Error('Slot generation only applies to slot_based resources');
    }

    const slots: { startsAt: Date; endsAt: Date }[] = [];
    const [sy, sm, sd] = date.split('-').map(Number);
    const [sh, smin] = startTime.split(':').map(Number);
    const [eh, emin] = endTime.split(':').map(Number);
    const start = new Date(Date.UTC(sy, sm - 1, sd, sh, smin, 0));
    const end = new Date(Date.UTC(sy, sm - 1, sd, eh, emin, 0));
    const IST_OFFSET = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;

    let cursor = new Date(start.getTime() + IST_OFFSET);
    const endIST = new Date(end.getTime() + IST_OFFSET);
    while (cursor < endIST) {
      const windowEnd = new Date(cursor.getTime() + slotDurationMinutes * 60000);
      if (windowEnd > endIST) break;
      slots.push({ startsAt: new Date(cursor.getTime() - IST_OFFSET), endsAt: new Date(windowEnd.getTime() - IST_OFFSET) });
      cursor = windowEnd;
    }

    let created = 0;
    const client = await getPool();
    try {
      await client.query('BEGIN');
      for (const slot of slots) {
        const result = await client.query(
          `INSERT INTO turf_availability_units (resource_id, starts_at, ends_at, price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource_id, starts_at, ends_at) WHERE seat_label IS NULL AND total_capacity IS NULL DO NOTHING`,
          [resourceId, slot.startsAt.toISOString(), slot.endsAt.toISOString(), price ?? null]
        );
        if ((result as any).rowCount > 0) created++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    return { requested: slots.length, created, skippedExisting: slots.length - created };
  }

  async lockSlot(unitId: number, holderId: number): Promise<TurfAvailabilityUnitRow> {
    await this.reclaimExpiredLocksForUnit(unitId);
    const existing = await this.findById(unitId);
    if (!existing) throw new Error('Availability unit not found');
    if (existing.status !== 'available') {
      throw new Error('This slot is no longer available');
    }

    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'locked', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'available'
       RETURNING *`,
      [unitId, holderId]
    );
    if (!rows.length) {
      throw new Error('This slot is no longer available');
    }
    return rows[0] as TurfAvailabilityUnitRow;
  }

  async releaseSlot(unitId: number, holderId: number): Promise<TurfAvailabilityUnitRow | null> {
    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`,
      [unitId, holderId]
    );
    return rows.length > 0 ? (rows[0] as TurfAvailabilityUnitRow) : null;
  }

  async markPaymentPending(unitId: number, holderId: number): Promise<TurfAvailabilityUnitRow | null> {
    const { rows } = await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'payment_pending', lock_holder_id = $2, lock_expires_at = NOW() + INTERVAL '5 minutes'
       WHERE id = $1 AND status = 'locked' AND lock_holder_id = $2
       RETURNING *`,
      [unitId, holderId]
    );
    return rows.length > 0 ? (rows[0] as TurfAvailabilityUnitRow) : null;
  }

  async markBooked(unitId: number): Promise<void> {
    await getPool().query(
      "UPDATE turf_availability_units SET status = 'booked' WHERE id = $1 AND status = 'locked'",
      [unitId]
    );
  }

  async markAvailable(unitId: number): Promise<void> {
    await getPool().query(
      "UPDATE turf_availability_units SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL WHERE id = $1",
      [unitId]
    );
  }

  private async reclaimExpiredLocksForUnit(resourceId: number): Promise<void> {
    await getPool().query(
      `UPDATE turf_availability_units
       SET status = 'available', lock_holder_id = NULL, lock_expires_at = NULL
       WHERE resource_id = $1 AND status = 'locked' AND lock_expires_at < NOW()`,
      [resourceId]
    );
  }

  async toPublic(row: TurfAvailabilityUnitRow): Promise<TurfAvailabilityUnitPublic> {
    return {
      ...row,
      price: row.price ? parseFloat(row.price) : null,
    };
  }
}

export const turfAvailabilityRepository = new TurfAvailabilityRepository();
