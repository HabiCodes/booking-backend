"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureUploadDirs = ensureUploadDirs;
exports.saveUpload = saveUpload;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
const pool_1 = require("../db/pool");
const fileUploadRepository_1 = require("../repositories/fileUploadRepository");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const imageDimensions_1 = require("../utils/imageDimensions");
const ALLOWED_MIME_TYPES = new Set(config_1.config.uploads.allowedMimeTypes);
/**
 * Ensure the upload directory tree exists. Called once at startup.
 */
function ensureUploadDirs() {
    const base = path_1.default.resolve(config_1.config.uploads.baseDir);
    for (const dir of Object.values(config_1.config.uploads.directories)) {
        const full = path_1.default.join(base, dir);
        fs_1.default.mkdirSync(full, { recursive: true });
    }
    logger_1.logger.info(`Upload directories ready at ${base}`);
}
/**
 * Validate a raw file Buffer:
 *  - MIME type from magic bytes (not from user-supplied content-type header)
 *  - Size limits
 *  - Dimensions (with optional minimums for banners)
 */
function validateImage(buf, allowedMimes, maxBytes, options = {}) {
    if (buf.length > maxBytes) {
        throw new errorHandler_1.AppError(`File too large — maximum size is ${maxBytes / 1024 / 1024}MB`, 413);
    }
    // Detect MIME from magic bytes
    let mimeType = null;
    if (buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47) {
        mimeType = 'image/png';
    }
    else if (buf[0] === 0xff && buf[1] === 0xd8) {
        mimeType = 'image/jpeg';
    }
    else if (buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50) {
        mimeType = 'image/webp';
    }
    if (!mimeType || !allowedMimes.has(mimeType)) {
        throw new errorHandler_1.AppError(`Unsupported file type — allowed: ${[...allowedMimes].join(', ')}`, 415);
    }
    const dims = (0, imageDimensions_1.getImageDimensions)(buf);
    if (!dims) {
        throw new errorHandler_1.AppError('Could not read image dimensions — file may be corrupt', 400);
    }
    if (options.minWidth && dims.width < options.minWidth) {
        throw new errorHandler_1.AppError(`Image too narrow — minimum width is ${options.minWidth}px (got ${dims.width}px)`, 400);
    }
    if (options.minHeight && dims.height < options.minHeight) {
        throw new errorHandler_1.AppError(`Image too short — minimum height is ${options.minHeight}px (got ${dims.height}px)`, 400);
    }
    return { mimeType, ...dims };
}
/**
 * Save an uploaded image buffer to disk and record it in the ledger.
 *
 * @param buf          Raw file bytes
 * @param subdir       One of config.uploads.directories keys
 * @param maxBytes     Max file size in bytes
 * @param options      Optional dimension constraints
 * @param uploadedBy   Admin ID who initiated the upload
 */
async function saveUpload(buf, subdir, maxBytes, options = {}, uploadedBy = null) {
    const { mimeType, width, height } = validateImage(buf, ALLOWED_MIME_TYPES, maxBytes, options);
    const ext = mimeType === 'image/png' ? '.png'
        : mimeType === 'image/webp' ? '.webp'
            : '.jpg';
    const storedName = `${crypto_1.default.randomUUID()}${ext}`;
    const dir = path_1.default.resolve(config_1.config.uploads.baseDir, config_1.config.uploads.directories[subdir]);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const fullPath = path_1.default.join(dir, storedName);
    fs_1.default.writeFileSync(fullPath, buf);
    const relativePath = path_1.default.join(config_1.config.uploads.directories[subdir], storedName);
    const url = `/uploads/${relativePath.replace(/\\/g, '/')}`;
    // Record in ledger (best-effort)
    const record = await fileUploadRepository_1.fileUploadRepository.createFileUpload((0, pool_1.getPool)(), {
        originalName: storedName,
        storedName: relativePath,
        mimeType,
        sizeBytes: buf.length,
        width,
        height,
        entityType: subdir,
        entityId: null,
        uploadedBy,
    }).catch((err) => {
        logger_1.logger.warn('file_uploads ledger insert failed:', err.message);
        return undefined;
    });
    logger_1.logger.info(`Saved upload: ${mimeType} ${width}x${height} ${buf.length}B → ${relativePath} (ledger#${record?.id ?? '?'})`);
    return { storedName, mimeType, sizeBytes: buf.length, width, height, fullPath, url };
}
