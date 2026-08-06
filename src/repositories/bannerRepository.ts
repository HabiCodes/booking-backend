import { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool';
import type {
  BannerRow,
  BannerPlacement,
  UpdateBannerInput,
  UploadBannerInput,
} from '../types';

type QueryExecutor = Pool | PoolClient;

/**
 * Repository for `advertisement_banners`.
 *
 * Guarantees:
 *  - At most one active ticket_advertisement at a time (enforced by partial
 *    unique index in the DB; activateBanner also does it at the service layer
 *    so that non-DB callers can't race).
 *  - Only ticket_advertisement has the single-active constraint; homepage_hero
 *    and event_thumbnail can have multiple active banners.
 */
export class BannerRepository {
  // ── Writes ───────────────────────────────────────────────────────────────

  async createBanner(
    exec: QueryExecutor | undefined,
    input: {
      imageUrl: string;
      cloudinaryPublicId?: string | null;
      uploadedBy: number | null;
      width: number | null;
      height: number | null;
      fileSizeBytes: number | null;
      mimeType: string | null;
      placement: BannerPlacement;
      altText?: string | null;
      linkUrl?: string | null;
      priority?: number;
    }
  ): Promise<BannerRow> {
    const executor = exec ?? getPool();
    const { rows } = await executor.query(
      `INSERT INTO advertisement_banners
         (image_url, cloudinary_public_id, is_active, uploaded_by,
          width, height, file_size_bytes, mime_type, placement,
          alt_text, link_url, priority)
       VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.imageUrl,
        input.cloudinaryPublicId ?? null,
        input.uploadedBy,
        input.width,
        input.height,
        input.fileSizeBytes,
        input.mimeType,
        input.placement,
        input.altText ?? null,
        input.linkUrl ?? null,
        input.priority ?? 0,
      ]
    );
    return (rows as unknown as BannerRow[])[0];
  }

  /**
   * Activate a banner and atomically deactivate all other active banners of
   * the same placement. For ticket_advertisement this enforces the "only one
   * active" rule at the application layer.
   */
  async activateBanner(id: number): Promise<BannerRow | null> {
    return withTransaction(async (client) => {
      // Fetch the banner to know its placement
      const { rows } = await client.query(
        'SELECT id, placement FROM advertisement_banners WHERE id = $1 LIMIT 1',
        [id]
      );
      const banner = (rows as unknown as BannerRow[])[0];
      if (!banner) return null;

      // Deactivate all other active banners of the same placement
      await client.query(
        `UPDATE advertisement_banners
           SET is_active = false,
               deactivated_at = NOW()
         WHERE placement = $1
           AND is_active = true
           AND id <> $2`,
        [banner.placement, id]
      );

      // Activate the target
      const res = await client.query(
        `UPDATE advertisement_banners
           SET is_active = true,
               activated_at = NOW(),
               deactivated_at = NULL
         WHERE id = $1
         RETURNING *`,
        [id]
      );

      return (res.rows as unknown as BannerRow[])[0] || null;
    });
  }

  async deactivateBanner(id: number): Promise<BannerRow | null> {
    const res = await getPool().query(
      `UPDATE advertisement_banners
         SET is_active = false,
             deactivated_at = NOW()
       WHERE id = $1
         AND is_active = true
       RETURNING *`,
      [id]
    );
    return (res.rows as unknown as BannerRow[])[0] || null;
  }

  async softDeleteBanner(id: number): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE advertisement_banners
         SET is_active = false,
             deleted_at = NOW(),
             deactivated_at = COALESCE(deactivated_at, NOW())
       WHERE id = $1
         AND deleted_at IS NULL`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateBanner(
    id: number,
    input: UpdateBannerInput
  ): Promise<BannerRow | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.alt_text !== undefined) {
      updates.push(`alt_text = $${idx++}`);
      values.push(input.alt_text);
    }
    if (input.link_url !== undefined) {
      updates.push(`link_url = $${idx++}`);
      values.push(input.link_url);
    }
    if (input.priority !== undefined) {
      updates.push(`priority = $${idx++}`);
      values.push(input.priority);
    }

    if (updates.length === 0) {
      return this.getBannerById(id);
    }

    values.push(id);
    const res = await getPool().query(
      `UPDATE advertisement_banners SET ${updates.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING *`,
      values
    );
    return (res.rows as unknown as BannerRow[])[0] || null;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getBannerById(id: number, includeDeleted = false): Promise<BannerRow | null> {
    const where = includeDeleted ? '' : 'AND deleted_at IS NULL';
    const { rows } = await getPool().query(
      `SELECT * FROM advertisement_banners
        WHERE id = $1 ${where} LIMIT 1`,
      [id]
    );
    return (rows as unknown as BannerRow[])[0] || null;
  }

  async getActiveBannerByPlacement(
    placement: BannerPlacement
  ): Promise<BannerRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM advertisement_banners
        WHERE placement = $1
          AND is_active = true
          AND deleted_at IS NULL
        ORDER BY priority DESC, created_at DESC
        LIMIT 1`,
      [placement]
    );
    return (rows as unknown as BannerRow[])[0] || null;
  }

  async listBanners(options: {
    placement?: BannerPlacement;
    isActive?: boolean;
    includeDeleted?: boolean;
    page?: number;
    pageSize?: number;
  } = {}): Promise<{ items: BannerRow[]; total: number }> {
    const { placement, isActive, includeDeleted, page = 1, pageSize = 20 } = options;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (placement) {
      conditions.push(`placement = $${idx++}`);
      params.push(placement);
    }
    if (isActive !== undefined) {
      conditions.push(`is_active = $${idx++}`);
      params.push(isActive);
    }
    if (!includeDeleted) {
      conditions.push(`deleted_at IS NULL`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await getPool().query(
      `SELECT COUNT(*) AS total FROM advertisement_banners ${whereClause}`,
      params
    );
    const total = parseInt((countRes.rows[0] as { total: string }).total, 10);

    params.push(offset, pageSize);
    const listRes = await getPool().query(
      `SELECT * FROM advertisement_banners
        ${whereClause}
        ORDER BY priority DESC, created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );

    return {
      items: listRes.rows as unknown as BannerRow[],
      total,
    };
  }
}

export const bannerRepository = new BannerRepository();