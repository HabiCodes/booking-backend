"use strict";
/**
 * Event repository — full CRUD, search/filter/pagination, soft delete.
 *
 * The schema in 000_initial_schema.sql and 002_events_expansion.sql gives us:
 *   id, title, subtitle, description, category, venue, address, city, state,
 *   country, latitude, longitude, start_at, end_at, event_date, start_time,
 *   end_time, capacity, remaining_capacity, price, currency, banner_url,
 *   thumbnail_url, logo_url, gallery JSONB, status, visibility, is_featured,
 *   is_active, organizer, created_at, updated_at, published_at, deleted_at
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventRepository = exports.EventRepository = void 0;
const pool_1 = require("../db/pool");
const PUBLIC_EVENT_COLUMNS = `
  id, title, subtitle, description, category, venue,
  address, city, state, country, latitude, longitude,
  start_at, end_at, event_date, start_time, end_time,
  capacity, remaining_capacity, price, currency,
  banner_url, thumbnail_url, logo_url, gallery,
  status, visibility, is_featured, is_active, organizer,
  cancel_window_hours, cancellable_until,
  submitted_for_review_at, approved_at, approved_by, archived_at,
  created_at, updated_at, published_at, deleted_at
`;
class EventRepository {
    // ── Reads ─────────────────────────────────────────────────────────────────
    async getActiveEvent() {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
       ORDER BY created_at ASC LIMIT 1`);
        return rows[0] || null;
    }
    async getEventById(id) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);
        return rows[0] || null;
    }
    async listPublicEvents(query) {
        const conditions = [
            "deleted_at IS NULL",
            "status = 'published'",
            "visibility = 'public'",
        ];
        const params = [];
        const search = query.search ?? query.q;
        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
        }
        if (query.category) {
            params.push(query.category);
            conditions.push(`category = $${params.length}`);
        }
        if (query.city) {
            params.push(query.city);
            conditions.push(`city = $${params.length}`);
        }
        if (query.fromDate) {
            params.push(query.fromDate);
            conditions.push(`event_date >= $${params.length}`);
        }
        if (query.toDate) {
            params.push(query.toDate);
            conditions.push(`event_date <= $${params.length}`);
        }
        if (query.featured === true) {
            conditions.push('is_featured = true');
        }
        const pageSize = Math.min(query.pageSize ?? query.limit ?? 20, 100);
        const page = query.page ?? (query.offset !== undefined ? Math.floor(query.offset / pageSize) + 1 : 1);
        const offset = query.offset !== undefined ? query.offset : (page - 1) * pageSize;
        const where = conditions.join(' AND ');
        const orderCol = ['created_at', 'event_date', 'title'].includes(query.sortBy ?? '')
            ? query.sortBy
            : 'created_at';
        const orderDir = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';
        const itemsResult = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE ${where}
       ORDER BY
         is_featured DESC,
         ${orderCol} ${orderDir} NULLS LAST,
         created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`, params);
        const countResult = await (0, pool_1.getPool)().query(`SELECT COUNT(*) AS total FROM events WHERE ${where}`, params);
        const total = parseInt(String(countResult.rows[0]?.total ?? 0), 10);
        return {
            items: itemsResult.rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    async listAllEvents(query) {
        // Admin view — includes drafts, hidden, and soft-deleted records
        const conditions = [];
        const params = [];
        const search = query.search ?? query.q;
        if (search) {
            params.push(`%${search}%`);
            conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
        }
        if (query.status) {
            params.push(query.status);
            conditions.push(`status = $${params.length}`);
        }
        if (query.category) {
            params.push(query.category);
            conditions.push(`category = $${params.length}`);
        }
        if (query.city) {
            params.push(query.city);
            conditions.push(`city = $${params.length}`);
        }
        if (query.include_deleted !== true) {
            conditions.push('deleted_at IS NULL');
        }
        const pageSize = Math.min(query.pageSize ?? 50, 200);
        const page = query.page ?? 1;
        const offset = (page - 1) * pageSize;
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const itemsResult = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       ${where}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`, params);
        const countResult = await (0, pool_1.getPool)().query(`SELECT COUNT(*) AS total FROM events ${where}`, params);
        const total = parseInt(String(countResult.rows[0]?.total ?? 0), 10);
        return {
            items: itemsResult.rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    async listFeaturedEvents(pageSize = 5) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
         AND is_featured = true
         AND (event_date >= CURRENT_DATE OR event_date IS NULL)
       ORDER BY event_date ASC
       LIMIT ${Math.min(pageSize, 50)}`);
        return rows;
    }
    /**
     * Distinct list of categories currently in use by public events.
     * Useful for populating filter dropdowns on the public listing page.
     */
    async listPublicCategories() {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT category, COUNT(*)::int AS count
         FROM events
        WHERE deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
          AND category IS NOT NULL
          AND category <> ''
        GROUP BY category
        ORDER BY count DESC, category ASC`);
        return rows;
    }
    /**
     * Distinct list of cities currently hosting public events.
     * Useful for city filter dropdowns.
     */
    async listPublicCities() {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT city, COUNT(*)::int AS count
         FROM events
        WHERE deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
          AND city IS NOT NULL
          AND city <> ''
        GROUP BY city
        ORDER BY count DESC, city ASC`);
        return rows;
    }
    /**
     * Related events — same category, upcoming, excluding the source event.
     * Used on the event detail page to recommend similar events.
     */
    async listRelatedEvents(eventId, category, limit = 4) {
        const params = [eventId];
        const categoryClause = category ? `AND category = $${params.push(category)}` : '';
        const { rows } = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
        WHERE deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
          AND id <> $1
          ${categoryClause}
          AND (event_date >= CURRENT_DATE OR event_date IS NULL)
        ORDER BY
          is_featured DESC,
          event_date ASC NULLS LAST,
          created_at DESC
        LIMIT ${Math.min(limit, 20)}`, params);
        return rows;
    }
    // ── Mutations ─────────────────────────────────────────────────────────────
    async create(input) {
        const { rows } = await (0, pool_1.getPool)().query(`INSERT INTO events (
         title, subtitle, description, category, venue,
         address, city, state, country, latitude, longitude,
         start_at, end_at, event_date, start_time, end_time,
         capacity, remaining_capacity, price, currency,
         banner_url, thumbnail_url, logo_url, gallery,
         status, visibility, is_featured, is_active, organizer,
         cancel_window_hours, cancellable_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
       RETURNING id`, [
            input.title,
            input.subtitle ?? null,
            input.description ?? null,
            input.category ?? null,
            input.venue,
            input.address ?? null,
            input.city ?? null,
            input.state ?? null,
            input.country ?? 'India',
            input.latitude ?? null,
            input.longitude ?? null,
            input.start_at,
            input.end_at,
            input.event_date ?? null,
            input.start_time ?? null,
            input.end_time ?? null,
            input.capacity,
            input.remaining_capacity ?? input.capacity,
            input.price ?? 0,
            input.currency ?? 'INR',
            input.banner_url ?? null,
            input.thumbnail_url ?? null,
            input.logo_url ?? null,
            input.gallery ? JSON.stringify(input.gallery) : null,
            input.status ?? 'draft',
            input.visibility ?? 'public',
            input.is_featured ?? false,
            true,
            input.organizer ?? null,
            input.cancel_window_hours ?? 6,
            input.start_at && (input.cancel_window_hours ?? 6) !== undefined
                ? new Date(new Date(input.start_at).getTime() -
                    (input.cancel_window_hours ?? 6) * 3600000).toISOString()
                : null,
        ]);
        const result = rows[0];
        return result?.id ?? 0;
    }
    async update(id, input) {
        const fields = [];
        const values = [];
        let idx = 1;
        const setField = (column, val) => {
            if (val !== undefined) {
                values.push(val);
                fields.push(`${column} = $${idx}`);
                idx++;
            }
        };
        setField('subtitle', input.subtitle);
        setField('description', input.description);
        setField('category', input.category);
        setField('venue', input.venue);
        setField('address', input.address);
        setField('city', input.city);
        setField('state', input.state);
        setField('country', input.country);
        setField('latitude', input.latitude);
        setField('longitude', input.longitude);
        setField('start_at', input.start_at);
        setField('end_at', input.end_at);
        setField('event_date', input.event_date);
        setField('start_time', input.start_time);
        setField('end_time', input.end_time);
        setField('capacity', input.capacity);
        setField('price', input.price);
        setField('currency', input.currency);
        setField('banner_url', input.banner_url);
        setField('thumbnail_url', input.thumbnail_url);
        setField('logo_url', input.logo_url);
        setField('status', input.status);
        setField('visibility', input.visibility);
        setField('is_featured', input.is_featured);
        setField('is_active', input.is_active);
        setField('cancel_window_hours', input.cancel_window_hours);
        // Recompute cancellable_until when start_at or cancel_window_hours changes
        if (input.start_at !== undefined || input.cancel_window_hours !== undefined) {
            fields.push(`cancellable_until = start_at - (cancel_window_hours || ' hours')::INTERVAL`);
        }
        if (input.gallery !== undefined) {
            values.push(JSON.stringify(input.gallery));
            fields.push(`gallery = $${idx}`);
            idx++;
        }
        // Auto-cap remaining_capacity if capacity decreased below current value
        if (input.capacity !== undefined) {
            values.push(input.capacity);
            fields.push(`remaining_capacity = LEAST(remaining_capacity, $${idx})`);
            idx++;
        }
        if (fields.length === 0) {
            return this.getEventById(id);
        }
        values.push(id);
        const { rows } = await (0, pool_1.getPool)().query(`UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`, values);
        return rows[0] || null;
    }
    async publish(id) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events
       SET status = 'published', published_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`, [id]);
        return (result.rowCount ?? 0) > 0;
    }
    async hide(id) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events SET status = 'hidden', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`, [id]);
        return (result.rowCount ?? 0) > 0;
    }
    async cancel(id) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`, [id]);
        return (result.rowCount ?? 0) > 0;
    }
    async setFeatured(id, isFeatured) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events SET is_featured = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`, [id, isFeatured]);
        return (result.rowCount ?? 0) > 0;
    }
    async softDelete(id) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`, [id]);
        return (result.rowCount ?? 0) > 0;
    }
    async restore(id) {
        const result = await (0, pool_1.getPool)().query(`UPDATE events SET deleted_at = NULL, updated_at = NOW()
       WHERE id = $1`, [id]);
        return (result.rowCount ?? 0) > 0;
    }
    // ── Booking integration helpers (atomic) ──────────────────────────────────
    async decrementRemainingCapacity(eventId, count) {
        const rows = await (0, pool_1.withTransaction)(async (client) => {
            const result = await client.query(`UPDATE events
         SET remaining_capacity = GREATEST(0, remaining_capacity - $2),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND remaining_capacity >= $2
         RETURNING remaining_capacity`, [eventId, count]);
            return result.rows;
        });
        const row = rows[0];
        return row ? (typeof row.remaining_capacity === 'string'
            ? parseInt(row.remaining_capacity, 10)
            : Number(row.remaining_capacity)) : 0;
    }
    async incrementRemainingCapacity(eventId, count) {
        const rows = await (0, pool_1.withTransaction)(async (client) => {
            const result = await client.query(`UPDATE events
         SET remaining_capacity = LEAST(capacity, remaining_capacity + $2),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING remaining_capacity`, [eventId, count]);
            return result.rows;
        });
        const row = rows[0];
        return row ? (typeof row.remaining_capacity === 'string'
            ? parseInt(row.remaining_capacity, 10)
            : Number(row.remaining_capacity)) : 0;
    }
    // ── Stats (kept for backward compat) ──────────────────────────────────────
    async getBookedCount(eventId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COALESCE(SUM(ticket_count), 0) AS total FROM bookings WHERE event_id = $1`, [eventId]);
        const row = rows;
        const total = row[0]?.total ?? 0;
        return typeof total === 'string' ? parseInt(total, 10) : Number(total);
    }
    async getEventCapacity(eventId) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT capacity FROM events WHERE id = $1', [eventId]);
        const row = rows;
        const cap = row[0]?.capacity ?? 0;
        return typeof cap === 'string' ? parseInt(cap, 10) : Number(cap);
    }
    async getBookingStats(eventId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT e.capacity,
              COALESCE(SUM(b.ticket_count), 0) AS "bookedCount"
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       WHERE e.id = $1
       GROUP BY e.capacity`, [eventId]);
        const arr = rows;
        const row = arr[0] ?? { capacity: 0, bookedCount: 0 };
        const capacity = typeof row.capacity === 'string' ? parseInt(row.capacity, 10) : Number(row.capacity);
        const bookedCount = typeof row.bookedCount === 'string' ? parseInt(row.bookedCount, 10) : Number(row.bookedCount);
        return {
            capacity,
            bookedCount,
            remaining: Math.max(0, capacity - bookedCount),
        };
    }
    async getRemainingTickets(eventId) {
        const stats = await this.getBookingStats(eventId);
        return stats.remaining;
    }
    // ── Lifecycle workflow (Migration 014) ────────────────────────────────────
    /**
     * Update only the workflow columns (submitted_for_review_at, approved_at,
     * approved_by, archived_at) on the event.  Used by the lifecycle service
     * to persist the side-effects of a status transition.
     *
     * Returns the updated row, or null if the event is missing / soft-deleted.
     */
    async updateWorkflowInfo(eventId, workflow, exec) {
        const fields = [];
        const values = [];
        let idx = 1;
        const setField = (col, val) => {
            if (val !== undefined) {
                values.push(val);
                fields.push(`${col} = $${idx}`);
                idx++;
            }
        };
        setField('submitted_for_review_at', workflow.submitted_for_review_at);
        setField('approved_at', workflow.approved_at);
        setField('approved_by', workflow.approved_by);
        setField('archived_at', workflow.archived_at);
        if (fields.length === 0) {
            return this.getEventById(eventId);
        }
        values.push(eventId);
        const client = exec ?? (0, pool_1.getPool)();
        const { rows } = await client.query(`UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`, values);
        return rows[0] || null;
    }
    /**
     * Update only the status column.  Used by the lifecycle service for
     * transitions whose side-effects are handled separately (workflow columns,
     * history row).  Returns the new row.
     */
    async updateStatus(eventId, status, exec) {
        const client = exec ?? (0, pool_1.getPool)();
        const { rows } = await client.query(`UPDATE events SET status = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`, [eventId, status]);
        return rows[0] || null;
    }
    /**
     * Returns the event's lifecycle workflow fields (snapshot for the API).
     */
    async getWorkflowInfo(eventId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT submitted_for_review_at, approved_at, approved_by, archived_at
         FROM events
        WHERE id = $1 AND deleted_at IS NULL`, [eventId]);
        const row = rows[0];
        if (!row)
            return null;
        return {
            submitted_for_review_at: row.submitted_for_review_at,
            approved_at: row.approved_at,
            approved_by: row.approved_by !== null
                ? (typeof row.approved_by === 'string' ? parseInt(row.approved_by, 10) : row.approved_by)
                : null,
            archived_at: row.archived_at,
        };
    }
    /**
     * List events in pending_review status — used by the admin review queue.
     */
    async listPendingReview(pageSize = 50, page = 1) {
        const offset = (page - 1) * pageSize;
        const itemsResult = await (0, pool_1.getPool)().query(`SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
        WHERE deleted_at IS NULL AND status = 'pending_review'
        ORDER BY submitted_for_review_at ASC NULLS LAST, created_at ASC
        LIMIT ${pageSize} OFFSET ${offset}`);
        const countResult = await (0, pool_1.getPool)().query(`SELECT COUNT(*) AS total FROM events WHERE deleted_at IS NULL AND status = 'pending_review'`);
        const total = parseInt(String(countResult.rows[0]?.total ?? 0), 10);
        return {
            items: itemsResult.rows,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize),
        };
    }
    // ── Status history (Migration 014) ────────────────────────────────────────
    /**
     * Insert one row into event_status_history.  If `exec` (transaction client)
     * is provided the insert participates in the same transaction.
     */
    async insertStatusHistory(row, exec) {
        const client = exec ?? (0, pool_1.getPool)();
        const { rows } = await client.query(`INSERT INTO event_status_history
         (event_id, actor_admin_id, from_status, to_status, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_id, actor_admin_id, from_status, to_status, reason, metadata, created_at`, [
            row.eventId,
            row.actorAdminId ?? null,
            row.fromStatus,
            row.toStatus,
            row.reason ?? null,
            JSON.stringify(row.metadata ?? {}),
        ]);
        return rows[0];
    }
    /**
     * Fetch the full history for an event (most-recent first).
     */
    async getStatusHistory(eventId, limit = 50) {
        const result = await (0, pool_1.getPool)().query(`SELECT id, event_id, actor_admin_id, from_status, to_status, reason, metadata, created_at
         FROM event_status_history
        WHERE event_id = $1
        ORDER BY created_at DESC
        LIMIT $2`, [eventId, Math.min(limit, 200)]);
        return result.rows;
    }
}
exports.EventRepository = EventRepository;
exports.eventRepository = new EventRepository();
