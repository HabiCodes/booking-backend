"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookingRepository = exports.BookingRepository = void 0;
const pool_1 = require("../db/pool");
const uuid_1 = require("uuid");
const qrCode_1 = require("../utils/qrCode");
class BookingRepository {
    // ── Writes ─────────────────────────────────────────────────────────────────
    async createBooking(exec, userId, eventId, ticketCount) {
        const { rows } = await exec.query('INSERT INTO bookings (user_id, event_id, ticket_count) VALUES ($1, $2, $3) RETURNING id', [userId, eventId, ticketCount]);
        const row = rows;
        return row[0]?.id ?? 0;
    }
    async createTickets(exec, bookingId, attendees) {
        if (attendees.length === 0)
            return [];
        const inserted = [];
        // Insert one-at-a-time so we can sign each ticket with deterministic
        // event data. Bulk inserts are not possible here because the signature
        // depends on the ticket's own UUID.
        const uuidGenerator = () => (0, uuid_1.v4)();
        for (const att of attendees) {
            const ticketUuid = uuidGenerator();
            const { rows } = await exec.query(`INSERT INTO tickets
           (booking_id, ticket_uuid, attendee_name, attendee_phone, attendee_age, attendee_gender, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`, [
                bookingId,
                ticketUuid,
                att.full_name.trim(),
                att.phone.trim(),
                att.age !== undefined && att.age !== null && att.age !== ''
                    ? parseInt(String(att.age), 10)
                    : null,
                att.gender?.toLowerCase().trim() || null,
            ]);
            inserted.push(rows[0]);
        }
        return inserted;
    }
    /**
     * Backfill signatures for the tickets just inserted. Called from the service
     * layer after the booking is committed so we have event_id and start_at.
     */
    async signTickets(tickets, eventId, eventStartAt, exec = (0, pool_1.getPool)()) {
        for (const t of tickets) {
            const signature = (0, qrCode_1.signTicket)({ ticket_uuid: t.ticket_uuid }, eventId, eventStartAt);
            await exec.query('UPDATE tickets SET signature = $1 WHERE id = $2', [signature, t.id]);
            t.signature = signature;
        }
    }
    // ── Reads ───────────────────────────────────────────────────────────────────
    async getBookingWithTickets(bookingId, userId) {
        const params = [bookingId];
        let userFilter = '';
        if (userId !== undefined) {
            userFilter = ' AND user_id = $2';
            params.push(userId);
        }
        const bookingRes = await (0, pool_1.getPool)().query(`SELECT * FROM bookings WHERE id = $1${userFilter} LIMIT 1`, params);
        const booking = bookingRes.rows[0];
        if (!booking)
            return null;
        const ticketRes = await (0, pool_1.getPool)().query('SELECT * FROM tickets WHERE booking_id = $1 ORDER BY id ASC', [bookingId]);
        return { booking, tickets: ticketRes.rows };
    }
    async getTicketsByUuid(ticketUuid) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM tickets WHERE ticket_uuid = $1 LIMIT 1', [ticketUuid]);
        return rows[0] || null;
    }
    async markTicketCheckedIn(ticketUuid, adminId) {
        const result = await (0, pool_1.getPool)().query(`UPDATE tickets SET checked_in = true, checked_in_at = NOW(), checked_in_by = $1
       WHERE ticket_uuid = $2 AND checked_in = false`, [adminId, ticketUuid]);
        return (result.rowCount ?? 0) > 0;
    }
    async getAllBookings(limit, offset) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT b.*, u.email AS user_email
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`, [limit, offset]);
        return rows;
    }
    // ── Capacity (atomic) ──────────────────────────────────────────────────────
    /**
     * Atomic capacity reservation. Locks the event row with FOR UPDATE inside a
     * transaction and decrements remaining_capacity only if it has enough room.
     * Returns the new remaining_capacity on success, or -1 if there isn't enough
     * capacity. The caller MUST wrap this in a transaction with the insert.
     */
    async reserveCapacity(exec, eventId, ticketCount) {
        const lockRes = await exec.query(`SELECT id, remaining_capacity, capacity, status, is_active, deleted_at, start_at
       FROM events
       WHERE id = $1
       FOR UPDATE`, [eventId]);
        const event = lockRes.rows[0];
        if (!event)
            return -1;
        if (event.deleted_at !== null)
            return -1;
        if (event.status === 'cancelled')
            return -1;
        if (event.is_active === false)
            return -1;
        const remaining = typeof event.remaining_capacity === 'string'
            ? parseInt(event.remaining_capacity, 10)
            : Number(event.remaining_capacity ?? event.capacity);
        if (remaining < ticketCount)
            return -1;
        const updateRes = await exec.query(`UPDATE events
         SET remaining_capacity = remaining_capacity - $2,
             updated_at = NOW()
       WHERE id = $1
       RETURNING remaining_capacity`, [eventId, ticketCount]);
        const newVal = updateRes.rows[0]?.remaining_capacity;
        return typeof newVal === 'string' ? parseInt(newVal, 10) : Number(newVal ?? 0);
    }
    /**
     * Release previously reserved capacity. Used when cancelling an active booking.
     * Caps at the event's capacity in case of drift.
     */
    async releaseCapacity(exec, eventId, ticketCount) {
        const res = await exec.query(`UPDATE events
         SET remaining_capacity = LEAST(capacity, remaining_capacity + $2),
             updated_at = NOW()
       WHERE id = $1
       RETURNING remaining_capacity`, [eventId, ticketCount]);
        const newVal = res.rows[0]?.remaining_capacity;
        return typeof newVal === 'string' ? parseInt(newVal, 10) : Number(newVal ?? 0);
    }
    // ── Per-user-per-event rule enforcement ────────────────────────────────────
    /**
     * Count the user's active (non-cancelled) tickets already booked for an event.
     * Used to enforce the per-user-per-event cap.
     */
    async getUserBookedCount(userId, eventId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COALESCE(SUM(ticket_count), 0) AS total
         FROM bookings
        WHERE user_id = $1
          AND event_id = $2
          AND status IN ('pending', 'confirmed', 'attended')`, [userId, eventId]);
        const total = rows[0]?.total ?? 0;
        return typeof total === 'string' ? parseInt(total, 10) : Number(total);
    }
    // ── Cancellation ───────────────────────────────────────────────────────────
    async cancelBooking(bookingId, userId, reason) {
        return (0, pool_1.withTransaction)(async (client) => {
            const lockRes = await client.query(`SELECT * FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`, [bookingId, userId]);
            const booking = lockRes.rows[0];
            if (!booking) {
                return { cancelled: false, ticketCount: 0, eventId: null };
            }
            if (booking.status === 'cancelled') {
                return { cancelled: false, ticketCount: booking.ticket_count, eventId: booking.event_id };
            }
            const updateRes = await client.query(`UPDATE bookings
            SET status = 'cancelled',
                cancelled_at = NOW(),
                cancellation_reason = $2,
                updated_at = NOW()
          WHERE id = $1
          RETURNING ticket_count, event_id`, [bookingId, reason]);
            const updated = updateRes.rows[0];
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
    async writeBookingAudit(bookingId, ticketId, actorType, actorId, action, metadata = {}) {
        try {
            await (0, pool_1.getPool)().query(`INSERT INTO booking_audit_logs
           (booking_id, ticket_id, actor_type, actor_id, action, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [bookingId, ticketId, actorType, actorId, action, JSON.stringify(metadata)]);
        }
        catch (err) {
            // Audit logging must never break the business operation
            // but we still want to surface it for ops.
            // eslint-disable-next-line no-console
            console.warn('booking_audit_logs insert failed:', err.message);
        }
    }
}
exports.BookingRepository = BookingRepository;
exports.bookingRepository = new BookingRepository();
