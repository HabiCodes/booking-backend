"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileUploadRepository = exports.FileUploadRepository = void 0;
const pool_1 = require("../db/pool");
/**
 * Repository for the `file_uploads` ledger.
 *
 * The ledger is a tamper-evident record of every image/file the app has ever
 * written to disk. It survives even when the actual file on disk is deleted —
 * which is how we keep a trail for audits while keeping the storage layer
 * simple.
 *
 * Writes are append-only. Deletes are soft (deleted_at).
 */
class FileUploadRepository {
    // ── Writes ───────────────────────────────────────────────────────────────
    async createFileUpload(exec, input) {
        const executor = exec ?? (0, pool_1.getPool)();
        const { rows } = await executor.query(`INSERT INTO file_uploads
         (original_name, stored_name, mime_type, size_bytes,
          width, height, entity_type, entity_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`, [
            input.originalName,
            input.storedName,
            input.mimeType,
            input.sizeBytes,
            input.width,
            input.height,
            input.entityType,
            input.entityId,
            input.uploadedBy,
        ]);
        return rows[0];
    }
    async softDeleteUpload(id) {
        const res = await (0, pool_1.getPool)().query(`UPDATE file_uploads
          SET deleted_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL`, [id]);
        return (res.rowCount ?? 0) > 0;
    }
    // ── Reads ────────────────────────────────────────────────────────────────
    async getUploadById(id) {
        const { rows } = await (0, pool_1.getPool)().query('SELECT * FROM file_uploads WHERE id = $1 LIMIT 1', [id]);
        return rows[0] || null;
    }
    async getUploadsByEntity(entityType, entityId, includeDeleted = false) {
        const where = includeDeleted ? '' : 'AND deleted_at IS NULL';
        const { rows } = await (0, pool_1.getPool)().query(`SELECT * FROM file_uploads
        WHERE entity_type = $1
          AND entity_id = $2
          ${where}
        ORDER BY created_at DESC`, [entityType, entityId]);
        return rows;
    }
}
exports.FileUploadRepository = FileUploadRepository;
exports.fileUploadRepository = new FileUploadRepository();
