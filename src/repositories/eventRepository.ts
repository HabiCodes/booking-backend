import { getPool } from '../db/pool';
import { EventRow } from '../types';

export class EventRepository {
  async getActiveEvent(): Promise<EventRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM events ORDER BY id ASC LIMIT 1'
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  async getEventById(id: number): Promise<EventRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM events WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  async getBookedCount(eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT COALESCE(SUM(ticket_count), 0) AS total FROM bookings WHERE event_id = $1',
      [eventId]
    );
    const row = rows as Array<{ total: number | string }>;
    const total = row[0]?.total ?? 0;
    return typeof total === 'string' ? parseInt(total, 10) : Number(total);
  }

  async getEventCapacity(eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      'SELECT capacity FROM events WHERE id = $1',
      [eventId]
    );
    const row = rows as Array<{ capacity: number | string }>;
    const cap = row[0]?.capacity ?? 0;
    return typeof cap === 'string' ? parseInt(cap, 10) : Number(cap);
  }

  /**
   * Combined single-query stats: { capacity, bookedCount, remaining }
   * Uses COALESCE(SUM(...), 0) — each booking can hold 1..10 tickets,
   * so we must sum ticket_count, not count booking rows.
   */
  async getBookingStats(eventId: number): Promise<{
    capacity: number;
    bookedCount: number;
    remaining: number;
  }> {
    const { rows } = await getPool().query(
      `SELECT e.capacity,
              COALESCE(SUM(b.ticket_count), 0) AS "bookedCount"
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       WHERE e.id = $1
       GROUP BY e.capacity`,
      [eventId]
    );
    const arr = rows as Array<{ capacity: number | string; bookedCount: number | string }>;
    const row = arr[0] ?? { capacity: 0, bookedCount: 0 };
    const capacity = typeof row.capacity === 'string' ? parseInt(row.capacity, 10) : Number(row.capacity);
    const bookedCount = typeof row.bookedCount === 'string' ? parseInt(row.bookedCount, 10) : Number(row.bookedCount);
    return {
      capacity,
      bookedCount,
      remaining: Math.max(0, capacity - bookedCount),
    };
  }

  async getRemainingTickets(eventId: number): Promise<number> {
    const stats = await this.getBookingStats(eventId);
    return stats.remaining;
  }
}

export const eventRepository = new EventRepository();
