"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bannerRepository = exports.BannerRepository = void 0;
const pool_1 = require("../db/pool");
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
class BannerRepository {
    // ── Writes ───────────────────────────────────────────────────────────────
    async createBanner(exec, input) {
        const executor = exec ?? (0, pool_1.getPool)();
        const { rows } = await executor.query(`INSERT INTO advertisement_banners
         (image_url, cloudinary_public_id, is_active, uploaded_by,
          width, height, file_size_bytes, mime_type, placement,
          alt_text, link_url, priority)
       VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`, [
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
        ]);
        return rows[0];
    }
    /**
     * Activate a banner and atomically deactivate all other active banners of
     * the same placement. For ticket_advertisement this enforces the "only one
     * active" rule at the application layer.
     */
    async activateBanner(id) {
        return (0, pool_1.withTransaction)(async (client) => {
            // Fetch the banner to know its placement
            const { rows } = await client.query('SELECT id, placement FROM advertisement_banners WHERE id = $1 LIMIT 1', [id]);
            const banner = rows[0];
            if (!banner)
                return null;
            // Deactivate all other active banners of the same placement
            await client.query(`UPDATE advertisement_banners
           SET is_active = false,
               deactivated_at = NOW()
         WHERE placement = $1
           AND is_active = true
           AND id <> $2`, [banner.placement, id]);
            // Activate the target
            const res = await client.query(`UPDATE advertisement_banners
           SET is_active = true,
               activated_at = NOW(),
               deactivated_at = NULL
         WHERE id = $1
         RETURNING *`, [id]);
            return res.rows[0] || null;
        });
    }
    async deactivateBanner(id) {
        const res = await (0, pool_1.getPool)().query(`UPDATE advertisement_banners
         SET is_active = false,
             deactivated_at = NOW()
       WHERE id = $1
         AND is_active = true
       RETURNING *`, [id]);
        return res.rows[0] || null;
    }
    async softDeleteBanner(id) {
        const res = await (0, pool_1.getPool)().query(`UPDATE advertisement_banners
         SET is_active = false,
             deleted_at = NOW(),
             deactivated_at = COALESCE(deactivated_at, NOW())
       WHERE id = $1
         AND deleted_at IS NULL`, [id]);
        return (res.rowCount ?? 0) > 0;
    }
    async updateBanner(id, input) {
        const updates = [];
        const values = [];
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
        const res = await (0, pool_1.getPool)().query(`UPDATE advertisement_banners SET ${updates.join(', ')}
       WHERE id = $${idx} AND deleted_at IS NULL
       RETURNING *`, values);
        return res.rows[0] || null;
    }
    // ── Reads ────────────────────────────────────────────────────────────────
    async getBannerById(id, includeDeleted = false) {
        const where = includeDeleted ? '' : 'AND deleted_at IS NULL';
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM advertisement_banners
        WHERE id = $1 ${where} LIMIT 1`, [id]);
        return rows[0] || null;
    }
    async getActiveBannerByPlacement(placement) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM advertisement_banners
        WHERE placement = $1
          AND is_active = true
          AND deleted_at IS NULL
        ORDER BY priority DESC, created_at DESC
        LIMIT 1`, [placement]);
        return rows[0] || null;
    }
    async listBanners(options = {}) {
        const { placement, isActive, includeDeleted, page = 1, pageSize = 20 } = options;
        const offset = (page - 1) * pageSize;
        const conditions = [];
        const params = [];
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
        const countRes = await (0, pool_1.getPool)().query(`SELECT COUNT(*) AS total FROM advertisement_banners ${whereClause}`, params);
        const total = parseInt(countRes.rows[0].total, 10);
        params.push(offset, pageSize);
        const listRes = await (0, pool_1.getPool)().query(`SELECT * FROM advertisement_banners
        ${whereClause}
        ORDER BY priority DESC, created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}`, params);
        return {
            items: listRes.rows,
            total,
        };
    }
}
exports.BannerRepository = BannerRepository;
exports.bannerRepository = new BannerRepository();
