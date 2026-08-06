"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonUploadMiddleware = jsonUploadMiddleware;
const errorHandler_1 = require("./errorHandler");
const MAX_REQUEST_BYTES = 15 * 1024 * 1024;
function jsonUploadMiddleware(req, _res, next) {
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
    if (contentLength > MAX_REQUEST_BYTES) {
        return next(new errorHandler_1.AppError(`Request too large — maximum upload is ${MAX_REQUEST_BYTES / 1024 / 1024}MB`, 413));
    }
    const body = req.body;
    if (!body || typeof body !== 'object') {
        return next();
    }
    if (!body.file) {
        return next();
    }
    if (typeof body.file !== 'string') {
        return next(new errorHandler_1.AppError('file must be a base64-encoded string', 400));
    }
    let buffer;
    try {
        buffer = Buffer.from(body.file, 'base64');
    }
    catch {
        return next(new errorHandler_1.AppError('Invalid base64 encoding', 400));
    }
    if (buffer.length === 0) {
        return next(new errorHandler_1.AppError('Uploaded file is empty', 400));
    }
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
    const originalName = typeof body.fileName === 'string' ? body.fileName : 'upload';
    req.upload = { buffer, mimeType, originalName };
    next();
}
