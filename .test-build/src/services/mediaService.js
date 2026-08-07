"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaService = exports.MediaService = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const mediaRepository_1 = require("../repositories/mediaRepository");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const imageDimensions_1 = require("../utils/imageDimensions");
// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = config_1.config.uploads?.maxFileSizeBytes ?? 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
]);
// ── Helpers ──────────────────────────────────────────────────────────────────
function validateMimeType(mimeType) {
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        throw new errorHandler_1.AppError(`Unsupported media type — allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`, 415);
    }
}
function validateByteSize(byteSize) {
    if (byteSize < 0) {
        throw new errorHandler_1.AppError('File size cannot be negative', 400);
    }
    if (byteSize > MAX_FILE_BYTES) {
        throw new errorHandler_1.AppError(`File too large — maximum size is ${MAX_FILE_BYTES / 1024 / 1024}MB`, 413);
    }
}
function validateImageDimensions(width, height) {
    if (width !== null && width !== undefined && width <= 0) {
        throw new errorHandler_1.AppError('Image width must be a positive integer', 400);
    }
    if (height !== null && height !== undefined && height <= 0) {
        throw new errorHandler_1.AppError('Image height must be a positive integer', 400);
    }
}
function hashBuffer(buf) {
    return crypto_1.default.createHash('sha256').update(buf).digest('hex');
}
// ── Service ──────────────────────────────────────────────────────────────────
class MediaService {
    // ── Upload + Create ──────────────────────────────────────────────────────
    /**
     * Process an upload buffer, dedup by SHA-256, create a media record.
     */
    async processUpload(buf, options) {
        validateMimeType(options.mimeType);
        validateByteSize(buf.length);
        const isImage = options.mimeType.startsWith('image/');
        let width = options.width ?? null;
        let height = options.height ?? null;
        if (isImage) {
            const dims = (0, imageDimensions_1.getImageDimensions)(buf);
            if (!dims) {
                throw new errorHandler_1.AppError('Could not read image dimensions — file may be corrupt', 400);
            }
            width = width ?? dims.width;
            height = height ?? dims.height;
        }
        validateImageDimensions(width, height);
        // SHA-256 dedup
        const sha256Hash = hashBuffer(buf);
        const existing = await mediaRepository_1.mediaRepository.findByHash(sha256Hash);
        if (existing) {
            logger_1.logger.info(`Media dedup: hash ${sha256Hash.slice(0, 12)}… → id ${existing.id}`);
            return this.toPublic(existing);
        }
        // Save to disk
        const subdir = options.subdir ?? 'events';
        const { storageKey, url } = this.saveToDiskSync(buf, options.mimeType, subdir);
        // Create media record
        const media = await mediaRepository_1.mediaRepository.create(undefined, {
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
        logger_1.logger.info(`Media created: id=${media.id} ${options.mimeType} → ${storageKey}`);
        return this.toPublic(media);
    }
    /**
     * Register media from metadata only (no buffer). Used for externally stored files (S3, CDN).
     */
    async registerExternalMedia(input) {
        const existing = await mediaRepository_1.mediaRepository.findByHash(input.sha256_hash);
        if (existing) {
            return this.toPublic(existing);
        }
        const media = await mediaRepository_1.mediaRepository.create(undefined, input);
        return this.toPublic(media);
    }
    // ── CRUD ──────────────────────────────────────────────────────────────────
    async getMedia(id) {
        const row = await mediaRepository_1.mediaRepository.findById(id);
        return row ? this.toPublic(row) : null;
    }
    async updateMedia(id, input) {
        const row = await mediaRepository_1.mediaRepository.update(id, input);
        return row ? this.toPublic(row) : null;
    }
    async deleteMedia(id, hard = false) {
        if (hard) {
            const res = await mediaRepository_1.mediaRepository.listEventMedia(id); // no-op, avoid direct pool access
            // Use repository's soft delete by default — hard delete requires explicit confirmation
            return mediaRepository_1.mediaRepository.softDelete(id);
        }
        return mediaRepository_1.mediaRepository.softDelete(id);
    }
    async restoreMedia(id) {
        return mediaRepository_1.mediaRepository.restore(id);
    }
    async listMedia(query) {
        return mediaRepository_1.mediaRepository.list(query);
    }
    // ── Event Media ───────────────────────────────────────────────────────────
    async attachToEvent(eventId, input, opts = {}) {
        // Verify media exists
        const media = await mediaRepository_1.mediaRepository.findByIdOrDeleted(input.media_id);
        if (!media) {
            throw new errorHandler_1.AppError(`Media #${input.media_id} not found`, 404);
        }
        if (media.deleted_at !== null) {
            throw new errorHandler_1.AppError(`Media #${input.media_id} has been deleted`, 409);
        }
        const attached = await mediaRepository_1.mediaRepository.attachToEvent(undefined, eventId, input.media_id, input);
        if (opts.makePrimary || input.is_primary) {
            await mediaRepository_1.mediaRepository.setPrimary(undefined, eventId, input.media_type, input.media_id);
            attached.is_primary = true;
        }
        return attached;
    }
    async updateEventMedia(eventMediaId, input) {
        if (input.is_primary === true) {
            const existing = await mediaRepository_1.mediaRepository.getEventMediaById(undefined, eventMediaId);
            if (existing) {
                const mediaType = input.media_type ?? existing.media_type;
                await mediaRepository_1.mediaRepository.setPrimary(undefined, existing.event_id, mediaType, existing.media_id);
            }
        }
        return mediaRepository_1.mediaRepository.updateEventMedia(undefined, eventMediaId, input);
    }
    async detachFromEvent(eventId, mediaId) {
        return mediaRepository_1.mediaRepository.detachFromEvent(undefined, eventId, mediaId);
    }
    async reorderEventMedia(eventId, mediaIdsInOrder) {
        const pairs = mediaIdsInOrder.map((mediaId, index) => ({ mediaId, displayOrder: index }));
        await mediaRepository_1.mediaRepository.reorder(undefined, eventId, pairs);
    }
    async getEventMedia(eventId, mediaType) {
        return mediaRepository_1.mediaRepository.listEventMedia(eventId, mediaType);
    }
    async getEventMediaWithDetails(eventId, mediaType) {
        const rows = await mediaRepository_1.mediaRepository.listEventMedia(eventId, mediaType);
        const mediaIds = rows.map((r) => r.media_id);
        const mediaMap = new Map();
        if (mediaIds.length > 0) {
            const mediaRows = await mediaRepository_1.mediaRepository.findByIds(mediaIds);
            for (const m of mediaRows) {
                mediaMap.set(m.id, this.toPublic(m));
            }
        }
        return rows
            .filter((r) => mediaMap.has(r.media_id))
            .map((r) => ({ ...r, media: mediaMap.get(r.media_id) }));
    }
    async getPrimaryForEvent(eventId, mediaType) {
        return mediaRepository_1.mediaRepository.getPrimaryMedia(eventId, mediaType);
    }
    async countEventMedia(eventId, mediaType) {
        return mediaRepository_1.mediaRepository.countByEvent(eventId, mediaType);
    }
    // ── Internal ──────────────────────────────────────────────────────────────
    toPublic(row) {
        const { uploaded_by, sha256_hash, storage_key, deleted_at, updated_at, ...rest } = row;
        const isVideo = row.mime_type.startsWith('video/');
        return {
            ...rest,
            video_provider: isVideo ? row.video_provider : null,
            duration_seconds: isVideo ? row.duration_seconds : null,
        };
    }
    /**
     * Save buffer to disk synchronously (crash-safe: write to .tmp then atomic rename).
     */
    saveToDiskSync(buf, mimeType, subdir) {
        const ext = this.extensionForMime(mimeType);
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomPart = crypto_1.default.randomBytes(8).toString('hex');
        const relativePath = `${stamp}/${randomPart}${ext}`;
        const uploadBase = config_1.config.uploads?.baseDir ?? path_1.default.resolve('uploads');
        const dir = path_1.default.join(uploadBase, subdir);
        fs_1.default.mkdirSync(dir, { recursive: true });
        // Atomic write: tmp → rename (rename is atomic on the same filesystem)
        const tmpPath = path_1.default.join(dir, `.tmp-${randomPart}${ext}`);
        const finalPath = path_1.default.join(dir, relativePath);
        fs_1.default.writeFileSync(tmpPath, buf);
        fs_1.default.renameSync(tmpPath, finalPath);
        const url = `/${subdir}/${relativePath}`.replace(/\\/g, '/');
        return { storageKey: relativePath, url };
    }
    extensionForMime(mimeType) {
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
exports.MediaService = MediaService;
exports.mediaService = new MediaService();
