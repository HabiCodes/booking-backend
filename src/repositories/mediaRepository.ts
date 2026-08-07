import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import type {
  EventMediaCreateInput,
  EventMediaListQuery,
  EventMediaRow,
  EventMediaUpdateInput,
  MediaCreateInput,
  MediaListQuery,
  MediaListResult,
  MediaPublic,
  MediaRow,
  MediaUpdateInput,
} from '../types';

type QueryExecutor = Pool | PoolClient;

// ── Column lists ─────────────────────────────────────────────────────────────

const MEDIA_COLUMNS = `
  id, uploaded_by, storage_provider, storage_key,
  file_name, mime_type, byte_size, sha256_hash,
  width, height,
  duration_seconds, video_provider, thumbnail_media_id,
  public_url,
  blur_hash, dominant_color, alt_text, is_public,
  deleted_at, created_at, updated_at
`;

const EVENT_MEDIA_COLUMNS = `
  id, event_id, media_id, media_type, display_order,
  status, is_primary, deleted_at, created_at
`;

const MEDIA_PUBLIC_COLUMNS = `
  id, storage_provider, file_name, mime_type, byte_size,
  width, height,
  duration_seconds, video_provider,
  public_url,
  blur_hash, dominant_color, alt_text, is_public,
  created_at
`;

// ── Repository ───────────────────────────────────────────────────────────────

export class MediaRepository {
  // ── Media writes ──────────────────────────────────────────────────────────

  async create(exec: QueryExecutor | undefined, input: MediaCreateInput): Promise<MediaRow> {
    const executor = exec ?? getPool();
    const { rows } = await executor.query(
      `INSERT INTO media
         (storage_provider, storage_key, file_name, mime_type, byte_size,
          sha256_hash, width, height, duration_seconds, video_provider,
          public_url, blur_hash, dominant_color, alt_text, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING ${MEDIA_COLUMNS}`,
      [
        input.storage_provider ?? 'local',
        input.storage_key,
        input.file_name,
        input.mime_type,
        input.byte_size,
        input.sha256_hash,
        input.width ?? null,
        input.height ?? null,
        input.duration_seconds ?? null,
        input.video_provider ?? null,
        input.public_url,
        input.blur_hash ?? null,
        input.dominant_color ?? null,
        input.alt_text ?? null,
        input.is_public ?? true,
      ]
    );
    return (rows as unknown as MediaRow[])[0];
  }

  async update(id: number, input: MediaUpdateInput): Promise<MediaRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.file_name !== undefined) { sets.push(`file_name = $${idx++}`); values.push(input.file_name); }
    if (input.mime_type !== undefined) { sets.push(`mime_type = $${idx++}`); values.push(input.mime_type); }
    if (input.public_url !== undefined) { sets.push(`public_url = $${idx++}`); values.push(input.public_url); }
    if (input.width !== undefined) { sets.push(`width = $${idx++}`); values.push(input.width); }
    if (input.height !== undefined) { sets.push(`height = $${idx++}`); values.push(input.height); }
    if (input.duration_seconds !== undefined) { sets.push(`duration_seconds = $${idx++}`); values.push(input.duration_seconds); }
    if (input.blur_hash !== undefined) { sets.push(`blur_hash = $${idx++}`); values.push(input.blur_hash); }
    if (input.dominant_color !== undefined) { sets.push(`dominant_color = $${idx++}`); values.push(input.dominant_color); }
    if (input.alt_text !== undefined) { sets.push(`alt_text = $${idx++}`); values.push(input.alt_text); }
    if (input.is_public !== undefined) { sets.push(`is_public = $${idx++}`); values.push(input.is_public); }
    if (input.deleted_at !== undefined) { sets.push(`deleted_at = $${idx++}`); values.push(input.deleted_at); }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const { rows } = await getPool().query(
      `UPDATE media SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${MEDIA_COLUMNS}`,
      values
    );
    return (rows as unknown as MediaRow[])[0] || null;
  }

  async softDelete(id: number): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE media SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async restore(id: number): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE media SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Media reads ───────────────────────────────────────────────────────────

  async findById(id: number): Promise<MediaRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return (rows as unknown as MediaRow[])[0] || null;
  }

  async findByIdOrDeleted(id: number): Promise<MediaRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${MEDIA_COLUMNS} FROM media WHERE id = $1 LIMIT 1`,
      [id]
    );
    return (rows as unknown as MediaRow[])[0] || null;
  }

  async findByIds(ids: number[]): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await getPool().query(
      `SELECT ${MEDIA_COLUMNS} FROM media
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      ids
    );
    return rows as unknown as MediaRow[];
  }

  async findByHash(sha256Hash: string): Promise<MediaRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${MEDIA_COLUMNS} FROM media
       WHERE sha256_hash = $1 AND deleted_at IS NULL LIMIT 1`,
      [sha256Hash]
    );
    return (rows as unknown as MediaRow[])[0] || null;
  }

  async list(query: MediaListQuery): Promise<MediaListResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (!query.include_deleted) {
      conditions.push('deleted_at IS NULL');
    }
    if (query.mime_type) {
      params.push(query.mime_type);
      conditions.push(`mime_type = $${idx++}`);
    }
    if (query.is_public !== undefined) {
      params.push(query.is_public);
      conditions.push(`is_public = $${idx++}`);
    }
    if (query.fromDate) {
      params.push(query.fromDate);
      conditions.push(`created_at >= $${idx++}`);
    }
    if (query.toDate) {
      params.push(query.toDate);
      conditions.push(`created_at <= $${idx++}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      conditions.push(`(file_name ILIKE $${idx++} OR mime_type ILIKE $${idx++})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count
    const countSql = `SELECT COUNT(*) AS total FROM media ${where}`;
    const countRes = await getPool().query(countSql, params);
    const total = Number(countRes.rows[0].total);

    // Pagination
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = query.pageSize && query.pageSize > 0 ? Math.min(query.pageSize, 100) : 20;
    const offset = (page - 1) * pageSize;

    const dataParams = [...params, pageSize, offset];

    const { rows } = await getPool().query(
      `SELECT ${MEDIA_PUBLIC_COLUMNS} FROM media ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      dataParams
    );

    const items = rows as unknown as MediaPublic[];
    const totalPages = Math.ceil(total / pageSize) || 1;

    return { items, total, page, pageSize, totalPages };
  }

  // ── Event-Media writes ────────────────────────────────────────────────────

  async attachToEvent(
    exec: QueryExecutor | undefined,
    eventId: number,
    mediaId: number,
    input: EventMediaCreateInput
  ): Promise<EventMediaRow> {
    const executor = exec ?? getPool();
    const { rows } = await executor.query(
      `INSERT INTO event_media
         (event_id, media_id, media_type, display_order, is_primary)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id, media_id) DO UPDATE
         SET media_type = EXCLUDED.media_type,
             display_order = EXCLUDED.display_order,
             is_primary = EXCLUDED.is_primary,
             deleted_at = NULL
       RETURNING ${EVENT_MEDIA_COLUMNS}`,
      [
        eventId,
        mediaId,
        input.media_type,
        input.display_order ?? 0,
        input.is_primary ?? false,
      ]
    );
    return (rows as unknown as EventMediaRow[])[0];
  }

  async updateEventMedia(
    exec: QueryExecutor | undefined,
    id: number,
    input: EventMediaUpdateInput
  ): Promise<EventMediaRow | null> {
    const executor = exec ?? getPool();
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.media_type !== undefined) { sets.push(`media_type = $${idx++}`); values.push(input.media_type); }
    if (input.display_order !== undefined) { sets.push(`display_order = $${idx++}`); values.push(input.display_order); }
    if (input.status !== undefined) { sets.push(`status = $${idx++}`); values.push(input.status); }
    if (input.is_primary !== undefined) { sets.push(`is_primary = $${idx++}`); values.push(input.is_primary); }

    if (sets.length === 0) {
      return this.getEventMediaById(exec, id);
    }

    values.push(id);
    const { rows } = await executor.query(
      `UPDATE event_media SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${EVENT_MEDIA_COLUMNS}`,
      values
    );
    return (rows as unknown as EventMediaRow[])[0] || null;
  }

  async detachFromEvent(exec: QueryExecutor | undefined, eventId: number, mediaId: number): Promise<boolean> {
    const executor = exec ?? getPool();
    const res = await executor.query(
      `UPDATE event_media SET deleted_at = NOW()
       WHERE event_id = $1 AND media_id = $2 AND deleted_at IS NULL`,
      [eventId, mediaId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setPrimary(exec: QueryExecutor | undefined, eventId: number, mediaType: string, mediaId: number): Promise<void> {
    const executor = exec ?? getPool();
    // Unset any existing primary for this event+type, then set the new one
    await executor.query(
      `UPDATE event_media SET is_primary = false
       WHERE event_id = $1 AND media_type = $2 AND is_primary = true AND deleted_at IS NULL`,
      [eventId, mediaType]
    );
    await executor.query(
      `UPDATE event_media SET is_primary = true
       WHERE event_id = $1 AND media_id = $2 AND media_type = $3 AND deleted_at IS NULL`,
      [eventId, mediaId, mediaType]
    );
  }

  async reorder(exec: QueryExecutor | undefined, eventId: number, orderedPairs: Array<{ mediaId: number; displayOrder: number }>): Promise<void> {
    const pool = exec ?? getPool();
    await pool.query('BEGIN');
    try {
      for (const pair of orderedPairs) {
        await pool.query(
          `UPDATE event_media SET display_order = $1
           WHERE event_id = $2 AND media_id = $3 AND deleted_at IS NULL`,
          [pair.displayOrder, eventId, pair.mediaId]
        );
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }

  // ── Event-Media reads ─────────────────────────────────────────────────────

  async getEventMediaById(
    exec: QueryExecutor | undefined,
    id: number
  ): Promise<EventMediaRow | null> {
    const executor = exec ?? getPool();
    const { rows } = await executor.query(
      `SELECT ${EVENT_MEDIA_COLUMNS} FROM event_media WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    return (rows as unknown as EventMediaRow[])[0] || null;
  }

  async getEventMedia(eventId: number, mediaId: number): Promise<EventMediaRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${EVENT_MEDIA_COLUMNS} FROM event_media
       WHERE event_id = $1 AND media_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [eventId, mediaId]
    );
    return (rows as unknown as EventMediaRow[])[0] || null;
  }

  async listEventMedia(
    eventId: number,
    mediaType?: string,
    includeDeleted = false
  ): Promise<EventMediaRow[]> {
    const conditions: string[] = ['event_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [eventId];
    let idx = 2;

    if (mediaType) {
      conditions.push(`media_type = $${idx++}`);
      params.push(mediaType);
    }

    if (includeDeleted) {
      // Remove the deleted_at filter and add both conditions
      const delIdx = conditions.indexOf('deleted_at IS NULL');
      conditions.splice(delIdx, 1);
    }

    const { rows } = await getPool().query(
      `SELECT ${EVENT_MEDIA_COLUMNS} FROM event_media
       WHERE ${conditions.join(' AND ')}
       ORDER BY display_order ASC, created_at ASC`,
      params
    );
    return rows as unknown as EventMediaRow[];
  }

  async getPrimaryMedia(eventId: number, mediaType: string): Promise<EventMediaRow | null> {
    const { rows } = await getPool().query(
      `SELECT ${EVENT_MEDIA_COLUMNS} FROM event_media
       WHERE event_id = $1 AND media_type = $2
         AND is_primary = true AND deleted_at IS NULL
       LIMIT 1`,
      [eventId, mediaType]
    );
    return (rows as unknown as EventMediaRow[])[0] || null;
  }

  async listByEvent(eventId: number, includeDeleted = false): Promise<EventMediaRow[]> {
    return this.listEventMedia(eventId, undefined, includeDeleted);
  }

  async countByEvent(eventId: number, mediaType?: string): Promise<number> {
    const conditions: string[] = ['event_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [eventId];
    let idx = 2;

    if (mediaType) {
      conditions.push(`media_type = $${idx++}`);
      params.push(mediaType);
    }

    const { rows } = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM event_media WHERE ${conditions.join(' AND ')}`,
      params
    );
    return Number(rows[0].cnt);
  }
}

export const mediaRepository = new MediaRepository();
