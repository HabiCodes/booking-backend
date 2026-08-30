import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { getPool } from '../db/pool';
import { fileUploadRepository } from '../repositories/fileUploadRepository';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getImageDimensions } from '../utils/imageDimensions';
import {
  getStorageBackend,
  generateStorageKey,
  extensionForMime,
  buildMediaUrl,
} from '../infrastructure/mediaStorage';
import { isS3Configured } from '../infrastructure/s3Client';

const ALLOWED_MIME_TYPES = new Set(config.uploads.allowedMimeTypes);

/**
 * Ensure upload directory tree exists. Called once at startup.
 * No-op when S3 is configured (no local dirs needed).
 */
export function ensureUploadDirs(): void {
  if (isS3Configured()) {
    logger.info('Upload dirs: skipped — S3 configured');
    return;
  }

  const base = path.resolve(config.uploads.baseDir);
  for (const dir of Object.values(config.uploads.directories)) {
    const full = path.join(base, dir);
    fs.mkdirSync(full, { recursive: true });
  }
  logger.info(`Upload directories ready at ${base}`);
}

/**
 * Result of a successful file save.
 */
export interface SavedFile {
  storedName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fullPath: string;
  url: string;
}

/**
 * Validate a raw file Buffer:
 *  - MIME type from magic bytes (not from user-supplied content-type header)
 *  - Size limits
 *  - Dimensions (with optional minimums for banners)
 */
function validateImage(
  buf: Buffer,
  allowedMimes: Set<string>,
  maxBytes: number,
  options: { minWidth?: number; minHeight?: number } = {}
): { mimeType: string; width: number | null; height: number | null } {
  if (buf.length > maxBytes) {
    throw new AppError(
      `File too large — maximum size is ${maxBytes / 1024 / 1024}MB`,
      413
    );
  }

  // Detect MIME from magic bytes
  let mimeType: string | null = null;
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    mimeType = 'image/png';
  } else if (buf[0] === 0xff && buf[1] === 0xd8) {
    mimeType = 'image/jpeg';
  } else if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    mimeType = 'image/webp';
  }

  if (!mimeType || !allowedMimes.has(mimeType)) {
    throw new AppError(
      `Unsupported file type — allowed: ${[...allowedMimes].join(', ')}`,
      415
    );
  }

  const dims = getImageDimensions(buf);
  if (!dims) {
    throw new AppError('Could not read image dimensions — file may be corrupt', 400);
  }

  if (options.minWidth && dims.width < options.minWidth) {
    throw new AppError(
      `Image too narrow — minimum width is ${options.minWidth}px (got ${dims.width}px)`,
      400
    );
  }
  if (options.minHeight && dims.height < options.minHeight) {
    throw new AppError(
      `Image too short — minimum height is ${options.minHeight}px (got ${dims.height}px)`,
      400
    );
  }

  return { mimeType, ...dims };
}

/**
 * Save an uploaded image buffer to storage (S3 or local) and record in the ledger.
 *
 * @param buf          Raw file bytes
 * @param subdir       One of config.uploads.directories keys
 * @param maxBytes     Max file size in bytes
 * @param options      Optional dimension constraints
 * @param uploadedBy   Admin ID who initiated the upload
 */
export async function saveUpload(
  buf: Buffer,
  subdir: 'events' | 'banners' | 'tickets' | 'movies' | 'turf',
  maxBytes: number,
  options: { minWidth?: number; minHeight?: number } = {},
  uploadedBy: number | null = null,
  organizationId: number | null = null
): Promise<SavedFile> {
  const { mimeType, width, height } = validateImage(buf, ALLOWED_MIME_TYPES, maxBytes, options);

  const storage = getStorageBackend();
  const ext = extensionForMime(mimeType);
  const key = generateStorageKey(subdir, mimeType);

  // Store via abstraction (S3 or local)
  const result = await storage.put(key, buf, mimeType);
  const url = buildMediaUrl(result.key);

  // Record in ledger (best-effort)
  const record = await fileUploadRepository.createFileUpload(getPool(), {
    originalName: path.basename(result.key),
    storedName: result.key,
    mimeType,
    sizeBytes: buf.length,
    width,
    height,
    entityType: subdir,
    entityId: null,
    uploadedBy,
  }).catch((err) => {
    logger.warn('file_uploads ledger insert failed:', (err as Error).message);
    return undefined;
  });

  logger.info(
    `Saved upload: ${mimeType} ${width}x${height} ${buf.length}B → ${result.key} (ledger#${record?.id ?? '?'})`
  );

  return {
    storedName: result.key,
    mimeType,
    sizeBytes: buf.length,
    width,
    height,
    fullPath: result.key,
    url,
  };
}
