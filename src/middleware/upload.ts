/**
 * Minimal in-memory upload handler.
 *
 * The app accepts image uploads via JSON bodies (base64-encoded file). This
 * keeps the dep tree small (no multer), and is appropriate for the moderate
 * upload sizes we allow (≤10MB). For larger files, swap in `multer` later.
 *
 * Expected body shape:
 *   {
 *     file:        string  — base64-encoded file contents
 *     mimeType:    string  — client-reported MIME (validated against magic bytes)
 *     fileName:    string  — optional, for the ledger
 *   }
 */
import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

export interface UploadRequest extends Request {
  upload?: {
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  };
}

const MAX_REQUEST_BYTES = 15 * 1024 * 1024;

export function jsonUploadMiddleware(
  req: UploadRequest,
  _res: Response,
  next: NextFunction
): void {
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_REQUEST_BYTES) {
    return next(new AppError(`Request too large — maximum upload is ${MAX_REQUEST_BYTES / 1024 / 1024}MB`, 413));
  }

  const body = req.body as { file?: unknown; mimeType?: unknown; fileName?: unknown } | undefined;
  if (!body || typeof body !== 'object') {
    return next();
  }
  if (!body.file) {
    return next();
  }
  if (typeof body.file !== 'string') {
    return next(new AppError('file must be a base64-encoded string', 400));
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.file, 'base64');
  } catch {
    return next(new AppError('Invalid base64 encoding', 400));
  }

  if (buffer.length === 0) {
    return next(new AppError('Uploaded file is empty', 400));
  }

  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream';
  const originalName = typeof body.fileName === 'string' ? body.fileName : 'upload';

  req.upload = { buffer, mimeType, originalName };
  next();
}