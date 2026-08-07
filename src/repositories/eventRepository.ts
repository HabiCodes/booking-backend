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

import { getPool, withTransaction } from '../db/pool';
import type {
  EventCreateInput,
  EventListQuery,
  EventListResult,
  EventRow,
  EventStatus,
  EventStatusHistoryRow,
  EventUpdateInput,
} from '../types';

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

export class EventRepository {
  // ── Reads ─────────────────────────────────────────────────────────────────

  async getActiveEvent(): Promise<EventRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
       ORDER BY created_at ASC LIMIT 1`
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  async getEventById(id: number): Promise<EventRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  async listPublicEvents(query: EventListQuery): Promise<EventListResult> {
    const conditions: string[] = [
      "deleted_at IS NULL",
      "status = 'published'",
      "visibility = 'public'",
    ];
    const params: unknown[] = [];

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

    const itemsResult = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE ${where}
       ORDER BY
         is_featured DESC,
         ${orderCol} ${orderDir} NULLS LAST,
         created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const countResult = await getPool().query(
      `SELECT COUNT(*) AS total FROM events WHERE ${where}`,
      params
    );

    const total = parseInt(String((countResult.rows as Array<{ total: number | string }>)[0]?.total ?? 0), 10);

    return {
      items: itemsResult.rows as unknown as EventRow[],
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async listAllEvents(query: EventListQuery): Promise<EventListResult> {
    // Admin view — includes drafts, hidden, and soft-deleted records
    const conditions: string[] = [];
    const params: unknown[] = [];

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

    const itemsResult = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       ${where}
       ORDER BY created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const countResult = await getPool().query(
      `SELECT COUNT(*) AS total FROM events ${where}`,
      params
    );

    const total = parseInt(String((countResult.rows as Array<{ total: number | string }>)[0]?.total ?? 0), 10);

    return {
      items: itemsResult.rows as unknown as EventRow[],
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async listFeaturedEvents(pageSize: number = 5): Promise<EventRow[]> {
    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
       WHERE deleted_at IS NULL
         AND status = 'published'
         AND visibility = 'public'
         AND is_featured = true
         AND (event_date >= CURRENT_DATE OR event_date IS NULL)
       ORDER BY event_date ASC
       LIMIT ${Math.min(pageSize, 50)}`
    );
    return rows as unknown as EventRow[];
  }

  /**
   * Distinct list of categories currently in use by public events.
   * Useful for populating filter dropdowns on the public listing page.
   */
  async listPublicCategories(): Promise<Array<{ category: string; count: number }>> {
    const { rows } = await getPool().query(
      `SELECT category, COUNT(*)::int AS count
         FROM events
        WHERE deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
          AND category IS NOT NULL
          AND category <> ''
        GROUP BY category
        ORDER BY count DESC, category ASC`
    );
    return rows as unknown as Array<{ category: string; count: number }>;
  }

  /**
   * Distinct list of cities currently hosting public events.
   * Useful for city filter dropdowns.
   */
  async listPublicCities(): Promise<Array<{ city: string; count: number }>> {
    const { rows } = await getPool().query(
      `SELECT city, COUNT(*)::int AS count
         FROM events
        WHERE deleted_at IS NULL
          AND status = 'published'
          AND visibility = 'public'
          AND city IS NOT NULL
          AND city <> ''
        GROUP BY city
        ORDER BY count DESC, city ASC`
    );
    return rows as unknown as Array<{ city: string; count: number }>;
  }

  /**
   * Related events — same category, upcoming, excluding the source event.
   * Used on the event detail page to recommend similar events.
   */
  async listRelatedEvents(eventId: number, category: string | null, limit: number = 4): Promise<EventRow[]> {
    const params: unknown[] = [eventId];
    const categoryClause = category ? `AND category = $${params.push(category)}` : '';
    const { rows } = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
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
        LIMIT ${Math.min(limit, 20)}`,
      params
    );
    return rows as unknown as EventRow[];
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async create(input: EventCreateInput): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO events (
         title, subtitle, description, category, venue,
         address, city, state, country, latitude, longitude,
         start_at, end_at, event_date, start_time, end_time,
         capacity, remaining_capacity, price, currency,
         banner_url, thumbnail_url, logo_url, gallery,
         status, visibility, is_featured, is_active, organizer,
         cancel_window_hours, cancellable_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
       RETURNING id`,
      [
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
        (input as any).organizer ?? null,
        input.cancel_window_hours ?? 6,
        input.start_at && (input.cancel_window_hours ?? 6) !== undefined
          ? new Date(
              new Date(input.start_at).getTime() -
                (input.cancel_window_hours ?? 6) * 3600_000
            ).toISOString()
          : null,
      ]
    );
    const result = (rows as unknown as Array<{ id: number }>)[0];
    return result?.id ?? 0;
  }

  async update(id: number, input: EventUpdateInput): Promise<EventRow | null> {
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
    const { rows } = await getPool().query(
      `UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`,
      values
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  async publish(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events
       SET status = 'published', published_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hide(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events SET status = 'hidden', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async cancel(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setFeatured(id: number, isFeatured: boolean): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events SET is_featured = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id, isFeatured]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async softDelete(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async restore(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE events SET deleted_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Booking integration helpers (atomic) ──────────────────────────────────

  async decrementRemainingCapacity(eventId: number, count: number): Promise<number> {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE events
         SET remaining_capacity = GREATEST(0, remaining_capacity - $2),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND remaining_capacity >= $2
         RETURNING remaining_capacity`,
        [eventId, count]
      );
      return result.rows as Array<{ remaining_capacity: number | string }>;
    });
    const row = rows[0];
    return row ? (typeof row.remaining_capacity === 'string'
      ? parseInt(row.remaining_capacity, 10)
      : Number(row.remaining_capacity)) : 0;
  }

  async incrementRemainingCapacity(eventId: number, count: number): Promise<number> {
    const rows = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE events
         SET remaining_capacity = LEAST(capacity, remaining_capacity + $2),
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING remaining_capacity`,
        [eventId, count]
      );
      return result.rows as Array<{ remaining_capacity: number | string }>;
    });
    const row = rows[0];
    return row ? (typeof row.remaining_capacity === 'string'
      ? parseInt(row.remaining_capacity, 10)
      : Number(row.remaining_capacity)) : 0;
  }

  // ── Stats (kept for backward compat) ──────────────────────────────────────

  async getBookedCount(eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COALESCE(SUM(ticket_count), 0) AS total FROM bookings WHERE event_id = $1`,
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

  // ── Lifecycle workflow (Migration 014) ────────────────────────────────────

  /**
   * Update only the workflow columns (submitted_for_review_at, approved_at,
   * approved_by, archived_at) on the event.  Used by the lifecycle service
   * to persist the side-effects of a status transition.
   *
   * Returns the updated row, or null if the event is missing / soft-deleted.
   */
  async updateWorkflowInfo(
    eventId: number,
    workflow: {
      submitted_for_review_at?: string | null;
      approved_at?: string | null;
      approved_by?: number | null;
      archived_at?: string | null;
    },
    exec?: import('pg').PoolClient
  ): Promise<EventRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    const setField = (col: string, val: unknown) => {
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
    const client = exec ?? getPool();
    const { rows } = await client.query(
      `UPDATE events SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`,
      values
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  /**
   * Update only the status column.  Used by the lifecycle service for
   * transitions whose side-effects are handled separately (workflow columns,
   * history row).  Returns the new row.
   */
  async updateStatus(
    eventId: number,
    status: EventStatus,
    exec?: import('pg').PoolClient
  ): Promise<EventRow | null> {
    const client = exec ?? getPool();
    const { rows } = await client.query(
      `UPDATE events SET status = $2, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING ${PUBLIC_EVENT_COLUMNS}`,
      [eventId, status]
    );
    return (rows as unknown as EventRow[])[0] || null;
  }

  /**
   * Returns the event's lifecycle workflow fields (snapshot for the API).
   */
  async getWorkflowInfo(eventId: number): Promise<{
    submitted_for_review_at: string | null;
    approved_at: string | null;
    approved_by: number | null;
    archived_at: string | null;
  } | null> {
    const { rows } = await getPool().query(
      `SELECT submitted_for_review_at, approved_at, approved_by, archived_at
         FROM events
        WHERE id = $1 AND deleted_at IS NULL`,
      [eventId]
    );
    const row = (rows as Array<{
      submitted_for_review_at: string | null;
      approved_at: string | null;
      approved_by: number | string | null;
      archived_at: string | null;
    }>)[0];
    if (!row) return null;
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
  async listPendingReview(pageSize: number = 50, page: number = 1): Promise<EventListResult> {
    const offset = (page - 1) * pageSize;
    const itemsResult = await getPool().query(
      `SELECT ${PUBLIC_EVENT_COLUMNS} FROM events
        WHERE deleted_at IS NULL AND status = 'pending_review'
        ORDER BY submitted_for_review_at ASC NULLS LAST, created_at ASC
        LIMIT ${pageSize} OFFSET ${offset}`
    );
    const countResult = await getPool().query(
      `SELECT COUNT(*) AS total FROM events WHERE deleted_at IS NULL AND status = 'pending_review'`
    );
    const total = parseInt(String((countResult.rows as Array<{ total: number | string }>)[0]?.total ?? 0), 10);
    return {
      items: itemsResult.rows as unknown as EventRow[],
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
  async insertStatusHistory(
    row: {
      eventId: number;
      actorAdminId?: number | null;
      fromStatus: EventStatus | null;
      toStatus: EventStatus;
      reason?: string | null;
      metadata?: Record<string, unknown>;
    },
    exec?: import('pg').PoolClient
  ): Promise<EventStatusHistoryRow> {
    const client = exec ?? getPool();
    const { rows } = await client.query(
      `INSERT INTO event_status_history
         (event_id, actor_admin_id, from_status, to_status, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_id, actor_admin_id, from_status, to_status, reason, metadata, created_at`,
      [
        row.eventId,
        row.actorAdminId ?? null,
        row.fromStatus,
        row.toStatus,
        row.reason ?? null,
        JSON.stringify(row.metadata ?? {}),
      ]
    );
    return rows[0] as unknown as EventStatusHistoryRow;
  }

  /**
   * Fetch the full history for an event (most-recent first).
   */
  async getStatusHistory(eventId: number, limit: number = 50): Promise<EventStatusHistoryRow[]> {
    const result = await getPool().query(
      `SELECT id, event_id, actor_admin_id, from_status, to_status, reason, metadata, created_at
         FROM event_status_history
        WHERE event_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [eventId, Math.min(limit, 200)]
    );
    return result.rows as unknown as EventStatusHistoryRow[];
  }
}

export const eventRepository = new EventRepository();
