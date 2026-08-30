/**
 * Media Storage Abstraction
 *
 * Provides a unified interface for storing and retrieving media files.
 * Implementation: S3 (primary) with local filesystem fallback.
 *
 * When S3 is configured:
 *  - All uploads go to S3
 *  - Public URLs proxy through our API: /api/media/proxy/{key}
 *  - S3 objects are never publicly accessible
 *  - No presigned URLs — always served through our auth-gated API
 *
 * When S3 is NOT configured:
 *  - Uses local filesystem (existing behavior)
 *  - URLs are direct /uploads/ paths
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { s3PutObject, s3GetObject, s3DeleteObject, isS3Configured } from './s3Client';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MediaStorageResult {
  key: string;
  url: string;
}

export interface MediaStorageBackend {
  put(key: string, buf: Buffer, contentType: string): Promise<MediaStorageResult>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// ── S3 Backend ────────────────────────────────────────────────────────────────

export class S3Storage implements MediaStorageBackend {
  async put(key: string, buf: Buffer, contentType: string): Promise<MediaStorageResult> {
    await s3PutObject(key, buf, contentType);
    return { key, url: '' }; // URL resolved by buildMediaUrl() at call site
  }

  async get(key: string): Promise<Buffer | null> {
    const result = await s3GetObject(key);
    return result?.body ?? null;
  }

  async delete(key: string): Promise<void> {
    await s3DeleteObject(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await s3GetObject(key);
    return result !== null;
  }
}

// ── Local Filesystem Backend ──────────────────────────────────────────────────

export class LocalStorage implements MediaStorageBackend {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async put(key: string, buf: Buffer, _contentType: string): Promise<MediaStorageResult> {
    const fullPath = path.join(this.baseDir, key.replace(/\\/g, '/'));

    // Atomic write: tmp -> rename
    const ext = path.extname(key);
    const randomPart = crypto.randomBytes(8).toString('hex');
    const tmpPath = `${fullPath}.tmp-${randomPart}`;
    const finalPath = `${fullPath}${ext}`;

    const dir = path.dirname(finalPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);

    const url = `/uploads/${key.replace(/\\/g, '/')}`;
    return { key: `${key}${ext}`, url };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const fullPath = path.join(this.baseDir, key.replace(/\\/g, '/'));
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const fullPath = path.join(this.baseDir, key.replace(/\\/g, '/'));
      fs.unlinkSync(fullPath);
    } catch {
      // Already deleted or never existed
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const fullPath = path.join(this.baseDir, key.replace(/\\/g, '/'));
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }
}

// ── Storage Factory ───────────────────────────────────────────────────────────

let backendInstance: MediaStorageBackend | null = null;

export function getStorageBackend(): MediaStorageBackend {
  if (backendInstance) return backendInstance;

  if (isS3Configured()) {
    logger.info('MediaStorage: Using S3 backend', {
      bucket: config.s3.bucket,
      region: config.s3.region,
    });
    backendInstance = new S3Storage();
  } else {
    const baseDir = path.resolve(config.uploads?.baseDir || './uploads');
    logger.info('MediaStorage: Using local filesystem backend', { baseDir });
    backendInstance = new LocalStorage(baseDir);
  }

  return backendInstance;
}

/**
 * Generate a safe, unpredictable storage key.
 * Format: {subdir}/{YYYYMMDD}/{random16hex}{ext}
 * Never uses user-provided filename.
 */
export function generateStorageKey(subdir: string, mimeType: string): string {
  const safeSubdir = subdir.replace(/[^a-zA-Z0-9_\-/]/g, '');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomPart = crypto.randomBytes(8).toString('hex');
  const ext = extensionForMime(mimeType);
  return `${safeSubdir}/${stamp}/${randomPart}${ext}`;
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'video/mp4': return '.mp4';
    case 'video/webm': return '.webm';
    default: return '.bin';
  }
}

/**
 * Build a URL suitable for API responses.
 */
export function buildMediaUrl(key: string): string {
  if (isS3Configured()) {
    return buildMediaProxyUrl(key);
  }
  const relativePath = key.replace(/\\/g, '/');
  return `/uploads/${relativePath}`;
}

function buildMediaProxyUrl(key: string): string {
  if (config.s3.publicBaseUrl) {
    const encodedKey = encodeURIComponent(key);
    return `${config.s3.publicBaseUrl}/api/media/proxy/${encodedKey}`;
  }
  const encodedKey = encodeURIComponent(key);
  return `/api/media/proxy/${encodedKey}`;
}
