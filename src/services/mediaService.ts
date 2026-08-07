import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { mediaRepository } from '../repositories/mediaRepository';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { getImageDimensions } from '../utils/imageDimensions';
import type {
  EventMediaCreateInput,
  EventMediaRow,
  EventMediaUpdateInput,
  MediaCreateInput,
  MediaPublic,
  MediaUpdateInput,
  MediaListQuery,
  MediaListResult,
} from '../types';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = config.uploads?.maxFileSizeBytes ?? 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new AppError(
      `Unsupported media type — allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      415
    );
  }
}

function validateByteSize(byteSize: number): void {
  if (byteSize < 0) {
    throw new AppError('File size cannot be negative', 400);
  }
  if (byteSize > MAX_FILE_BYTES) {
    throw new AppError(
      `File too large — maximum size is ${MAX_FILE_BYTES / 1024 / 1024}MB`,
      413
    );
  }
}

function validateImageDimensions(width: number | null | undefined, height: number | null | undefined): void {
  if (width !== null && width !== undefined && width <= 0) {
    throw new AppError('Image width must be a positive integer', 400);
  }
  if (height !== null && height !== undefined && height <= 0) {
    throw new AppError('Image height must be a positive integer', 400);
  }
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Service ──────────────────────────────────────────────────────────────────

export class MediaService {
  // ── Upload + Create ──────────────────────────────────────────────────────

  /**
   * Process an upload buffer, dedup by SHA-256, create a media record.
   */
  async processUpload(
    buf: Buffer,
    options: {
      mimeType: string;
      fileName: string;
      subdir?: 'events' | 'banners' | 'tickets';
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      videoProvider?: string | null;
      blurHash?: string | null;
      dominantColor?: string | null;
      altText?: string | null;
      isPublic?: boolean;
      uploadedBy?: number | null;
    }
  ): Promise<MediaPublic> {
    validateMimeType(options.mimeType);
    validateByteSize(buf.length);

    const isImage = options.mimeType.startsWith('image/');
    let width = options.width ?? null;
    let height = options.height ?? null;

    if (isImage) {
      const dims = getImageDimensions(buf);
      if (!dims) {
        throw new AppError('Could not read image dimensions — file may be corrupt', 400);
      }
      width = width ?? dims.width;
      height = height ?? dims.height;
    }

    validateImageDimensions(width, height);

    // SHA-256 dedup
    const sha256Hash = hashBuffer(buf);
    const existing = await mediaRepository.findByHash(sha256Hash);
    if (existing) {
      logger.info(`Media dedup: hash ${sha256Hash.slice(0, 12)}… → id ${existing.id}`);
      return this.toPublic(existing);
    }

    // Save to disk
    const subdir = options.subdir ?? 'events';
    const { storageKey, url } = this.saveToDiskSync(buf, options.mimeType, subdir);

    // Create media record
    const media = await mediaRepository.create(undefined, {
      storage_provider: 'local',
      storage_key: storageKey,
      file_name: options.fileName,
      mime_type: options.mimeType,
      byte_size: buf.length,
      sha256_hash: sha256Hash,
      width,
      height,
      duration_seconds: options.durationSeconds ?? null,
      video_provider: options.videoProvider ?? null,
      public_url: url,
      blur_hash: options.blurHash ?? null,
      dominant_color: options.dominantColor ?? null,
      alt_text: options.altText ?? null,
      is_public: options.isPublic ?? true,
    });

    logger.info(`Media created: id=${media.id} ${options.mimeType} → ${storageKey}`);
    return this.toPublic(media);
  }

  /**
   * Register media from metadata only (no buffer). Used for externally stored files (S3, CDN).
   */
  async registerExternalMedia(input: MediaCreateInput): Promise<MediaPublic> {
    const existing = await mediaRepository.findByHash(input.sha256_hash);
    if (existing) {
      return this.toPublic(existing);
    }
    const media = await mediaRepository.create(undefined, input);
    return this.toPublic(media);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async getMedia(id: number): Promise<MediaPublic | null> {
    const row = await mediaRepository.findById(id);
    return row ? this.toPublic(row) : null;
  }

  async updateMedia(id: number, input: MediaUpdateInput): Promise<MediaPublic | null> {
    const row = await mediaRepository.update(id, input);
    return row ? this.toPublic(row) : null;
  }

  async deleteMedia(id: number, hard = false): Promise<boolean> {
    if (hard) {
      const res = await mediaRepository.listEventMedia(id); // no-op, avoid direct pool access
      // Use repository's soft delete by default — hard delete requires explicit confirmation
      return mediaRepository.softDelete(id);
    }
    return mediaRepository.softDelete(id);
  }

  async restoreMedia(id: number): Promise<boolean> {
    return mediaRepository.restore(id);
  }

  async listMedia(query: MediaListQuery): Promise<MediaListResult> {
    return mediaRepository.list(query);
  }

  // ── Event Media ───────────────────────────────────────────────────────────

  async attachToEvent(
    eventId: number,
    input: EventMediaCreateInput,
    opts: { makePrimary?: boolean } = {}
  ): Promise<EventMediaRow> {
    // Verify media exists
    const media = await mediaRepository.findByIdOrDeleted(input.media_id);
    if (!media) {
      throw new AppError(`Media #${input.media_id} not found`, 404);
    }
    if (media.deleted_at !== null) {
      throw new AppError(`Media #${input.media_id} has been deleted`, 409);
    }

    const attached = await mediaRepository.attachToEvent(undefined, eventId, input.media_id, input);

    if (opts.makePrimary || input.is_primary) {
      await mediaRepository.setPrimary(undefined, eventId, input.media_type, input.media_id);
      attached.is_primary = true;
    }

    return attached;
  }

  async updateEventMedia(eventMediaId: number, input: EventMediaUpdateInput): Promise<EventMediaRow | null> {
    if (input.is_primary === true) {
      const existing = await mediaRepository.getEventMediaById(undefined, eventMediaId);
      if (existing) {
        const mediaType = input.media_type ?? existing.media_type;
        await mediaRepository.setPrimary(undefined, existing.event_id, mediaType, existing.media_id);
      }
    }
    return mediaRepository.updateEventMedia(undefined, eventMediaId, input);
  }

  async detachFromEvent(eventId: number, mediaId: number): Promise<boolean> {
    return mediaRepository.detachFromEvent(undefined, eventId, mediaId);
  }

  async reorderEventMedia(eventId: number, mediaIdsInOrder: number[]): Promise<void> {
    const pairs = mediaIdsInOrder.map((mediaId, index) => ({ mediaId, displayOrder: index }));
    await mediaRepository.reorder(undefined, eventId, pairs);
  }

  async getEventMedia(eventId: number, mediaType?: string) {
    return mediaRepository.listEventMedia(eventId, mediaType);
  }

  async getEventMediaWithDetails(eventId: number, mediaType?: string) {
    const rows = await mediaRepository.listEventMedia(eventId, mediaType);
    const mediaIds = rows.map((r) => r.media_id);
    const mediaMap = new Map<number, MediaPublic>();

    if (mediaIds.length > 0) {
      const mediaRows = await mediaRepository.findByIds(mediaIds);
      for (const m of mediaRows) {
        mediaMap.set(m.id, this.toPublic(m));
      }
    }

    return rows
      .filter((r) => mediaMap.has(r.media_id))
      .map((r) => ({ ...r, media: mediaMap.get(r.media_id)! }));
  }

  async getPrimaryForEvent(eventId: number, mediaType: string) {
    return mediaRepository.getPrimaryMedia(eventId, mediaType);
  }

  async countEventMedia(eventId: number, mediaType?: string): Promise<number> {
    return mediaRepository.countByEvent(eventId, mediaType);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private toPublic(row: import('../types').MediaRow): MediaPublic {
    const { uploaded_by, sha256_hash, storage_key, deleted_at, updated_at, ...rest } = row;
    const isVideo = row.mime_type.startsWith('video/');
    return {
      ...rest,
      video_provider: isVideo ? row.video_provider : null,
      duration_seconds: isVideo ? row.duration_seconds : null,
    } as MediaPublic;
  }

  /**
   * Save buffer to disk synchronously (crash-safe: write to .tmp then atomic rename).
   */
  private saveToDiskSync(buf: Buffer, mimeType: string, subdir: string): { storageKey: string; url: string } {
    const ext = this.extensionForMime(mimeType);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomPart = crypto.randomBytes(8).toString('hex');
    const relativePath = `${stamp}/${randomPart}${ext}`;

    const uploadBase = config.uploads?.baseDir ?? path.resolve('uploads');
    const dir = path.join(uploadBase, subdir);

    fs.mkdirSync(dir, { recursive: true });

    // Atomic write: tmp → rename (rename is atomic on the same filesystem)
    const tmpPath = path.join(dir, `.tmp-${randomPart}${ext}`);
    const finalPath = path.join(dir, relativePath);
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);

    const url = `/${subdir}/${relativePath}`.replace(/\\/g, '/');
    return { storageKey: relativePath, url };
  }

  private extensionForMime(mimeType: string): string {
    switch (mimeType) {
      case 'image/png': return '.png';
      case 'image/webp': return '.webp';
      case 'image/gif': return '.gif';
      case 'video/mp4': return '.mp4';
      case 'video/webm': return '.webm';
      default: return '.bin';
    }
  }
}

export const mediaService = new MediaService();
