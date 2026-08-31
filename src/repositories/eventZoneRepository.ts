/**
 * Event Zone repository — CRUD for event_zones and booking_zones tables.
 *
 * Tables (Migration 048):
 *   event_zones  — per-zone config (capacity, price, display order)
 *   booking_zones — joins a booking to the zone(s) it consumed tickets from
 */

import { getPool, withTransaction } from '../db/pool';
import type {
  EventZoneRow,
  EventZonePublic,
  EventZoneCreateInput,
  EventZoneUpdateInput,
  BookingZoneRow,
} from '../types';

const ZONE_COLUMNS = `
  id, event_id, name, description, color,
  total_capacity, remaining_capacity,
  price, currency,
  sort_order, is_active, deleted_at,
  created_at, updated_at
`;

export class EventZoneRepository {

  // ── Reads ───────────────────────────────────────────────────────────────────

  async getZoneById(id: number): Promise<EventZoneRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${ZONE_COLUMNS} FROM event_zones WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return (rows as unknown as EventZoneRow[])[0] || null;
  }

  /**
   * Get an active zone by ID. Requires both deleted_at IS NULL AND is_active = true.
   * Use this from the customer booking path and public read endpoints.
   * For admin operations that need to find inactive/deleted zones, use getZoneById().
   */
  async getActiveZoneById(id: number): Promise<EventZoneRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${ZONE_COLUMNS} FROM event_zones
       WHERE id = $1 AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
      [id]
    );
    return (rows as unknown as EventZoneRow[])[0] || null;
  }

  async getZonesByEvent(eventId: number, includeInactive: boolean = false): Promise<EventZoneRow[]> {
    const { rows } = await getPool().query(
      `SELECT ${ZONE_COLUMNS} FROM event_zones
       WHERE event_id = $1
         AND deleted_at IS NULL
         ${includeInactive ? '' : 'AND is_active = true'}
       ORDER BY sort_order ASC, id ASC`,
      [eventId]
    );
    return rows as unknown as EventZoneRow[];
  }

  async getActiveZonesByEvent(eventId: number): Promise<EventZoneRow[]> {
    return this.getZonesByEvent(eventId, false);
  }

  async getZoneByName(eventId: number, name: string): Promise<EventZoneRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${ZONE_COLUMNS} FROM event_zones
       WHERE event_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
      [eventId, name]
    );
    return (rows as unknown as EventZoneRow[])[0] || null;
  }

  async getZonesForBooking(bookingId: number): Promise<BookingZoneRow[]> {
    const { rows } = await getPool().query(
      `SELECT bz.*, ez.name as zone_name FROM booking_zones bz
       JOIN event_zones ez ON ez.id = bz.zone_id
       WHERE bz.booking_id = $1`,
      [bookingId]
    );
    return rows as unknown as BookingZoneRow[];
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  async createZone(input: EventZoneCreateInput & { event_id: number }): Promise<EventZoneRow> {
    const { rows } = await getPool().query(
      `INSERT INTO event_zones (event_id, name, description, color, total_capacity, remaining_capacity, price, currency, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.event_id,
        input.name,
        input.description ?? null,
        input.color ?? null,
        input.total_capacity,
        input.total_capacity,       // remaining_capacity starts at total
        input.price,
        input.currency ?? 'INR',
        input.sort_order ?? 0,
        true,
      ]
    );
    return (rows as unknown as EventZoneRow[])[0];
  }

  async updateZone(id: number, input: EventZoneUpdateInput): Promise<EventZoneRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const setField = (column: string, val: unknown) => {
      if (val !== undefined) {
        values.push(val);
        fields.push(`${column} = $${idx}`);
        idx++;
      }
    };

    setField('name', input.name);
    setField('description', input.description);
    setField('color', input.color);
    // When total_capacity is updated, also cap remaining_capacity to the new total.
    // This prevents the inconsistent state where remaining_capacity > total_capacity.
    if (input.total_capacity !== undefined) {
      values.push(input.total_capacity);
      fields.push(`total_capacity = $${idx}`);
      idx++;
      values.push(input.total_capacity);
      fields.push(`remaining_capacity = LEAST(remaining_capacity, $${idx})`);
      idx++;
    }
    setField('price', input.price);
    setField('is_active', input.is_active);
    setField('sort_order', input.sort_order);

    if (fields.length === 0) {
      return this.getZoneById(id);
    }

    values.push(id);
    const { rows } = await getPool().query(
      `UPDATE event_zones SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING ${ZONE_COLUMNS}`,
      values
    );
    return (rows as unknown as EventZoneRow[])[0] || null;
  }

  async softDeleteZone(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE event_zones SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Atomic capacity operations ───────────────────────────────────────────────

  /**
   * Atomically decrement zone remaining_capacity.
   * Returns the new remaining_capacity, or -1 if insufficient capacity OR zone
   * is not active/has been deleted. The is_active check prevents race windows
   * between zone deactivation and booking submission.
   */
  async decrementZoneCapacity(zoneId: number, count: number): Promise<number> {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE event_zones
         SET remaining_capacity = GREATEST(0, remaining_capacity - $2),
             updated_at = NOW()
         WHERE id = $1
           AND deleted_at IS NULL
           AND is_active = true
           AND remaining_capacity >= $2
         RETURNING remaining_capacity`,
        [zoneId, count]
      );
      return result.rows as Array<{ remaining_capacity: number | string }>;
    });
    const row = rows[0];
    if (!row) return -1; // insufficient capacity, inactive, deleted, or not found
    return typeof row.remaining_capacity === 'string'
      ? parseInt(row.remaining_capacity, 10)
      : Number(row.remaining_capacity);
  }

  /**
   * Increment zone remaining_capacity (on cancellation).
   * Includes deleted_at check — a deleted zone shouldn't accumulate capacity.
   */
  async incrementZoneCapacity(zoneId: number, count: number): Promise<number> {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE event_zones
         SET remaining_capacity = LEAST(total_capacity, remaining_capacity + $2),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING remaining_capacity`,
        [zoneId, count]
      );
      return result.rows as Array<{ remaining_capacity: number | string }>;
    });
    const row = rows[0];
    return row
      ? (typeof row.remaining_capacity === 'string'
        ? parseInt(row.remaining_capacity, 10)
        : Number(row.remaining_capacity))
      : 0;
  }

  // ── Booking zone join ───────────────────────────────────────────────────────

  async getBookingZone(bookingId: number): Promise<BookingZoneRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM booking_zones WHERE booking_id = $1 LIMIT 1`,
      [bookingId]
    );
    return (rows as unknown as BookingZoneRow[])[0] || null;
  }

  async createBookingZone(
    bookingId: number,
    zoneId: number,
    ticketCount: number,
    unitPricePaise: number,
  ): Promise<BookingZoneRow> {
    const { rows } = await getPool().query(
      `INSERT INTO booking_zones (booking_id, zone_id, ticket_count, unit_price_paise, subtotal_paise)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [bookingId, zoneId, ticketCount, unitPricePaise, ticketCount * unitPricePaise]
    );
    return (rows as unknown as BookingZoneRow[])[0];
  }

  async deleteBookingZones(bookingId: number): Promise<void> {
    await getPool().query(`DELETE FROM booking_zones WHERE booking_id = $1`, [bookingId]);
  }

  // ── Summary / stats ─────────────────────────────────────────────────────────

  async getZoneRemaining(eventId: number): Promise<Array<{
    zone_id: number;
    zone_name: string;
    total_capacity: number;
    remaining_capacity: number;
  }>> {
    const { rows } = await getPool().query(
      `SELECT id, name, total_capacity, remaining_capacity FROM event_zones
       WHERE event_id = $1 AND deleted_at IS NULL AND is_active = true
       ORDER BY sort_order ASC`,
      [eventId]
    );
    return (rows as Array<{
      id: number;
      name: string;
      total_capacity: number | string;
      remaining_capacity: number | string;
    }>).map(r => ({
      zone_id: r.id,
      zone_name: r.name,
      total_capacity: typeof r.total_capacity === 'string' ? parseInt(r.total_capacity, 10) : r.total_capacity,
      remaining_capacity: typeof r.remaining_capacity === 'string' ? parseInt(r.remaining_capacity, 10) : r.remaining_capacity,
    }));
  }
}

export const eventZoneRepository = new EventZoneRepository();
