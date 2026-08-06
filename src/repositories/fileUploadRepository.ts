import { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool';
import type { FileUploadRow } from '../types';

type QueryExecutor = Pool | PoolClient;

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
export class FileUploadRepository {
  // ── Writes ───────────────────────────────────────────────────────────────

  async createFileUpload(
    exec: QueryExecutor | undefined,
    input: {
      originalName: string;
      storedName: string;
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      entityType: string | null;
      entityId: number | null;
      uploadedBy: number | null;
    }
  ): Promise<FileUploadRow> {
    const executor = exec ?? getPool();
    const { rows } = await executor.query(
      `INSERT INTO file_uploads
         (original_name, stored_name, mime_type, size_bytes,
          width, height, entity_type, entity_id, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.originalName,
        input.storedName,
        input.mimeType,
        input.sizeBytes,
        input.width,
        input.height,
        input.entityType,
        input.entityId,
        input.uploadedBy,
      ]
    );
    return (rows as unknown as FileUploadRow[])[0];
  }

  async softDeleteUpload(id: number): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE file_uploads
          SET deleted_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL`,
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getUploadById(id: number): Promise<FileUploadRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM file_uploads WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as FileUploadRow[])[0] || null;
  }

  async getUploadsByEntity(
    entityType: string,
    entityId: number,
    includeDeleted = false
  ): Promise<FileUploadRow[]> {
    const where = includeDeleted ? '' : 'AND deleted_at IS NULL';
    const { rows } = await getPool().query(
      `SELECT * FROM file_uploads
        WHERE entity_type = $1
          AND entity_id = $2
          ${where}
        ORDER BY created_at DESC`,
      [entityType, entityId]
    );
    return rows as unknown as FileUploadRow[];
  }
}

export const fileUploadRepository = new FileUploadRepository();