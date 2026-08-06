import { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool';
import { BookingRow, TicketRow, CreateBookingInput } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { signTicket } from '../utils/qrCode';

type QueryExecutor = Pool | PoolClient;

export class BookingRepository {
  // ── Writes ─────────────────────────────────────────────────────────────────

  async createBooking(
    exec: QueryExecutor,
    userId: number,
    eventId: number,
    ticketCount: number
  ): Promise<number> {
    const { rows } = await exec.query(
      'INSERT INTO bookings (user_id, event_id, ticket_count) VALUES ($1, $2, $3) RETURNING id',
      [userId, eventId, ticketCount]
    );
    const row = rows as Array<{ id: number }>;
    return row[0]?.id ?? 0;
  }

  async createTickets(
    exec: QueryExecutor,
    bookingId: number,
    attendees: CreateBookingInput['attendees']
  ): Promise<TicketRow[]> {
    if (attendees.length === 0) return [];

    const inserted: TicketRow[] = [];

    // Insert one-at-a-time so we can sign each ticket with deterministic
    // event data. Bulk inserts are not possible here because the signature
    // depends on the ticket's own UUID.
    const uuidGenerator = (): string => uuidv4();
    for (const att of attendees) {
      const ticketUuid = uuidGenerator();
      const { rows } = await exec.query(
        `INSERT INTO tickets
           (booking_id, ticket_uuid, attendee_name, attendee_phone, attendee_age, attendee_gender, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [
          bookingId,
          ticketUuid,
          att.full_name.trim(),
          att.phone.trim(),
          att.age !== undefined && att.age !== null && att.age !== ''
            ? parseInt(String(att.age), 10)
            : null,
          att.gender?.toLowerCase().trim() || null,
        ]
      );
      inserted.push((rows as unknown as TicketRow[])[0]);
    }

    return inserted;
  }

  /**
   * Backfill signatures for the tickets just inserted. Called from the service
   * layer after the booking is committed so we have event_id and start_at.
   */
  async signTickets(
    tickets: TicketRow[],
    eventId: number,
    eventStartAt: string,
    exec: QueryExecutor = getPool()
  ): Promise<void> {
    for (const t of tickets) {
      const signature = signTicket({ ticket_uuid: t.ticket_uuid }, eventId, eventStartAt);
      await exec.query(
        'UPDATE tickets SET signature = $1 WHERE id = $2',
        [signature, t.id]
      );
      t.signature = signature;
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  async getBookingWithTickets(
    bookingId: number,
    userId?: number
  ): Promise<{ booking: BookingRow; tickets: TicketRow[] } | null> {
    const params: unknown[] = [bookingId];
    let userFilter = '';
    if (userId !== undefined) {
      userFilter = ' AND user_id = $2';
      params.push(userId);
    }

    const bookingRes = await getPool().query(
      `SELECT * FROM bookings WHERE id = $1${userFilter} LIMIT 1`,
      params
    );
    const booking = (bookingRes.rows as unknown as BookingRow[])[0];
    if (!booking) return null;

    const ticketRes = await getPool().query(
      'SELECT * FROM tickets WHERE booking_id = $1 ORDER BY id ASC',
      [bookingId]
    );
    return { booking, tickets: ticketRes.rows as unknown as TicketRow[] };
  }

  async getTicketsByUuid(ticketUuid: string): Promise<TicketRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM tickets WHERE ticket_uuid = $1 LIMIT 1',
      [ticketUuid]
    );
    return (rows as unknown as TicketRow[])[0] || null;
  }

  async markTicketCheckedIn(ticketUuid: string, adminId: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE tickets SET checked_in = true, checked_in_at = NOW(), checked_in_by = $1
       WHERE ticket_uuid = $2 AND checked_in = false`,
      [adminId, ticketUuid]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getAllBookings(
    limit: number,
    offset: number
  ): Promise<(BookingRow & { user_email: string })[]> {
    const { rows } = await getPool().query(
      `SELECT b.*, u.email AS user_email
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows as unknown as Array<BookingRow & { user_email: string }>;
  }

  // ── Capacity (atomic) ──────────────────────────────────────────────────────

  /**
   * Atomic capacity reservation. Locks the event row with FOR UPDATE inside a
   * transaction and decrements remaining_capacity only if it has enough room.
   * Returns the new remaining_capacity on success, or -1 if there isn't enough
   * capacity. The caller MUST wrap this in a transaction with the insert.
   */
  async reserveCapacity(
    exec: QueryExecutor,
    eventId: number,
    ticketCount: number
  ): Promise<number> {
    const lockRes = await exec.query(
      `SELECT id, remaining_capacity, capacity, status, is_active, deleted_at, start_at
       FROM events
       WHERE id = $1
       FOR UPDATE`,
      [eventId]
    );
    const event = (lockRes.rows as unknown as Array<{
      id: number;
      remaining_capacity: number | string | null;
      capacity: number | string;
      status: string;
      is_active: boolean;
      deleted_at: string | null;
      start_at: string;
    }>)[0];

    if (!event) return -1;
    if (event.deleted_at !== null) return -1;
    if (event.status === 'cancelled') return -1;
    if (event.is_active === false) return -1;

    const remaining = typeof event.remaining_capacity === 'string'
      ? parseInt(event.remaining_capacity, 10)
      : Number(event.remaining_capacity ?? event.capacity);

    if (remaining < ticketCount) return -1;

    const updateRes = await exec.query(
      `UPDATE events
         SET remaining_capacity = remaining_capacity - $2,
             updated_at = NOW()
       WHERE id = $1
       RETURNING remaining_capacity`,
      [eventId, ticketCount]
    );
    const newVal = (updateRes.rows as unknown as Array<{ remaining_capacity: number | string }>)[0]?.remaining_capacity;
    return typeof newVal === 'string' ? parseInt(newVal, 10) : Number(newVal ?? 0);
  }

  /**
   * Release previously reserved capacity. Used when cancelling an active booking.
   * Caps at the event's capacity in case of drift.
   */
  async releaseCapacity(
    exec: QueryExecutor,
    eventId: number,
    ticketCount: number
  ): Promise<number> {
    const res = await exec.query(
      `UPDATE events
         SET remaining_capacity = LEAST(capacity, remaining_capacity + $2),
             updated_at = NOW()
       WHERE id = $1
       RETURNING remaining_capacity`,
      [eventId, ticketCount]
    );
    const newVal = (res.rows as unknown as Array<{ remaining_capacity: number | string }>)[0]?.remaining_capacity;
    return typeof newVal === 'string' ? parseInt(newVal, 10) : Number(newVal ?? 0);
  }

  // ── Per-user-per-event rule enforcement ────────────────────────────────────

  /**
   * Count the user's active (non-cancelled) tickets already booked for an event.
   * Used to enforce the per-user-per-event cap.
   */
  async getUserBookedCount(userId: number, eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COALESCE(SUM(ticket_count), 0) AS total
         FROM bookings
        WHERE user_id = $1
          AND event_id = $2
          AND status IN ('pending', 'confirmed', 'attended')`,
      [userId, eventId]
    );
    const total = (rows as Array<{ total: number | string }>)[0]?.total ?? 0;
    return typeof total === 'string' ? parseInt(total, 10) : Number(total);
  }

  // ── Cancellation ───────────────────────────────────────────────────────────

  async cancelBooking(
    bookingId: number,
    userId: number,
    reason: string | null
  ): Promise<{ cancelled: boolean; ticketCount: number; eventId: number | null }> {
    return withTransaction(async (client) => {
      const lockRes = await client.query(
        `SELECT * FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [bookingId, userId]
      );
      const booking = (lockRes.rows as unknown as BookingRow[])[0];
      if (!booking) {
        return { cancelled: false, ticketCount: 0, eventId: null };
      }
      if (booking.status === 'cancelled') {
        return { cancelled: false, ticketCount: booking.ticket_count, eventId: booking.event_id };
      }

      const updateRes = await client.query(
        `UPDATE bookings
            SET status = 'cancelled',
                cancelled_at = NOW(),
                cancellation_reason = $2,
                updated_at = NOW()
          WHERE id = $1
          RETURNING ticket_count, event_id`,
        [bookingId, reason]
      );

      const updated = (updateRes.rows as unknown as Array<{ ticket_count: number | string; event_id: number }>)[0];
      const ticketCount = typeof updated?.ticket_count === 'string'
        ? parseInt(updated.ticket_count, 10)
        : Number(updated?.ticket_count ?? 0);

      // Release capacity
      if (updated?.event_id) {
        await this.releaseCapacity(client, updated.event_id, ticketCount);
      }

      return { cancelled: true, ticketCount, eventId: updated?.event_id ?? null };
    });
  }

  // ── Audit log ──────────────────────────────────────────────────────────────

  async writeBookingAudit(
    bookingId: number | null,
    ticketId: number | null,
    actorType: 'user' | 'admin' | 'system',
    actorId: number | null,
    action: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO booking_audit_logs
           (booking_id, ticket_id, actor_type, actor_id, action, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [bookingId, ticketId, actorType, actorId, action, JSON.stringify(metadata)]
      );
    } catch (err) {
      // Audit logging must never break the business operation
      // but we still want to surface it for ops.
      // eslint-disable-next-line no-console
      console.warn('booking_audit_logs insert failed:', (err as Error).message);
    }
  }
}

export const bookingRepository = new BookingRepository();
