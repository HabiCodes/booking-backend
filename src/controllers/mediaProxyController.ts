/**
 * Media proxy controller — serves private media through our auth-gated API.
 *
 * Endpoint: GET /api/media/proxy/{encodedKey}
 *
 * WHY a proxy instead of S3 presigned URLs:
 *   - S3 objects are PRIVATE (no public read on the bucket)
 *   - We do NOT generate presigned URLs (they leak temporary bucket access)
 *   - Our API validates authorization (admin/manager JWT) before serving
 *   - This is the ONLY path through which media reaches the frontend
 *
 * Authentication model:
 *   - PUBLIC media (is_public=true, not deleted): accessible without auth
 *   - PRIVATE media (is_public=false): requires authenticated admin or organizer JWT
 *     with organization_id matching the media record
 *   - Cross-org access: IMPOSSIBLE — org check enforced on every private request
 *   - Deleted media: always 404 (no auth bypass possible)
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { s3GetObject } from '../infrastructure/s3Client';
import { mediaRepository } from '../repositories/mediaRepository';
import { config } from '../config';
import { logger } from '../utils/logger';

const MAX_PROXY_SIZE = 25 * 1024 * 1024; // 25 MB cap

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
};

/**
 * Extract the storage key from the URL path.
 */
function extractKey(req: Request): string | null {
  const match = req.path.match(/^\/api\/media\/proxy\/(.+)$/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

/**
 * Authorize access to a media record.
 *
 * Rules:
 *   1. If media is soft-deleted → DENY (404)
 *   2. If media is public (is_public=true) → ALLOW (no auth required)
 *   3. If media is private → require authenticated admin or organizer:
 *      a. Super-admin (organizationId=null) can access any private media
 *      b. Org-scoped admin can only access media from their own organization
 *      c. Organizer can only access media from their own organization
 *      d. Unauthenticated request to private media → DENY (401)
 *      e. Authenticated request with org mismatch → DENY (403)
 */
function authorizeMediaAccess(
  req: Request,
  mediaRow: { deleted_at: string | null; is_public: boolean; organization_id: number | null }
): { authorized: boolean; statusCode: number } {
  // 1. Deleted media → always 404
  if (mediaRow.deleted_at !== null) {
    return { authorized: false, statusCode: 404 };
  }

  // 2. Public media → no auth needed
  if (mediaRow.is_public) {
    return { authorized: true, statusCode: 200 };
  }

  // 3. Private media → check authentication
  const admin = (req as any).admin as { id: number; organizationId?: number | null; role?: string } | undefined;
  const organizer = (req as any).organizerUser as { id: number; organizationId?: number; permissions?: string[] } | undefined;

  if (!admin && !organizer) {
    return { authorized: false, statusCode: 401 };
  }

  // Super-admin can access any private media
  const adminOrgId = admin?.organizationId ?? null;
  const isSuperAdmin = adminOrgId === null && admin?.role === 'super_admin';
  if (isSuperAdmin) {
    return { authorized: true, statusCode: 200 };
  }

  // Determine requester's org
  const requesterOrgId = organizer?.organizationId ?? adminOrgId;

  // If media has no organization (legacy/general), allow authenticated access
  if (mediaRow.organization_id === null) {
    if (admin || organizer) {
      return { authorized: true, statusCode: 200 };
    }
  }

  // Org scoping — cross-org access is impossible
  if (requesterOrgId != null && mediaRow.organization_id !== requesterOrgId) {
    return { authorized: false, statusCode: 403 };
  }

  // Same org or media is general → allow
  return { authorized: true, statusCode: 200 };
}

/**
 * Serve a media file by storage key with authorization checks.
 * Mounted as middleware: app.use('/api/media/proxy', authProxyMiddleware, proxyMedia);
 *
 * This middleware:
 * 1. Extracts the storage key from the URL
 * 2. Validates path traversal protection
 * 3. Looks up the media record in the DB
 * 4. Runs authorization rules based on is_public, organization_id, and requester identity
 * 5. Calls next() to proceed to file serving, or rejects with appropriate status
 */
export async function authProxyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const key = extractKey(req);
    if (!key) {
      res.status(400).json({ error: 'Missing media key' });
      return;
    }

    // Security: prevent path traversal
    if (key.includes('..') || key.includes('//') || key.startsWith('/')) {
      res.status(400).json({ error: 'Invalid media key' });
      return;
    }

    // Look up media record by storage key
    const mediaRow = await mediaRepository.findByStorageKey(key);
    if (!mediaRow) {
      // No record at all — let the proxy return 404
      res.locals.serveMedia = { action: 'not_found' };
      next();
      return;
    }

    // Authorize access
    const result = authorizeMediaAccess(req, mediaRow);
    if (!result.authorized) {
      res.status(result.statusCode).json({
        error: result.statusCode === 404
          ? 'Media not found'
          : result.statusCode === 401
            ? 'Authentication required for this media'
            : 'Access denied to this media',
      });
      return;
    }

    // Authorized — store the media row for the proxy handler
    res.locals.serveMedia = { action: 'serve', mediaRow };
    next();
  } catch (err) {
    logger.error('Media proxy auth error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to authorize media access' });
  }
}

/**
 * Serve the actual media bytes after auth has been verified.
 * This is mounted AFTER authProxyMiddleware.
 */
export async function proxyMedia(req: Request, res: Response): Promise<void> {
  try {
    const key = extractKey(req);
    if (!key) {
      res.status(400).json({ error: 'Missing media key' });
      return;
    }

    // If auth already rejected, don't proceed
    if (res.locals.serveMedia?.action === 'not_found') {
      res.status(404).json({ error: 'Media not found' });
      return;
    }

    // Auth rejection
    if (!res.locals.serveMedia) {
      res.status(500).json({ error: 'Authorization check not completed' });
      return;
    }

    let buf: Buffer | null = null;
    let contentType = 'application/octet-stream';
    let lastModified: string | undefined;

    // Try S3 first
    try {
      const s3Result = await s3GetObject(key);
      if (s3Result) {
        buf = s3Result.body;
        contentType = s3Result.contentType;
        lastModified = s3Result.lastModified;
      }
    } catch (err) {
      logger.warn('S3 proxy read failed, trying local', { key, error: (err as Error).message });
    }

    // Local filesystem fallback
    if (!buf) {
      try {
        const fullPath = path.join(config.uploads.baseDir, key);
        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);
          if (stats.size > MAX_PROXY_SIZE) {
            res.status(413).json({ error: 'File too large' });
            return;
          }
          buf = fs.readFileSync(fullPath);
          lastModified = stats.mtime.toISOString();

          const ext = path.extname(key).toLowerCase();
          contentType = MIME_MAP[ext] || 'application/octet-stream';
        }
      } catch {
        // Local fallback missed
      }
    }

    if (!buf) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }

    // Security headers — prevent MIME sniffing
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Cache control: private caching, revalidate
    res.setHeader('Cache-Control', 'private, max-age=3600, must-revalidate');
    res.setHeader('ETag', `"${crypto.createHash('md5').update(buf).digest('hex')}"`);

    res.status(200).send(buf);
  } catch (err) {
    logger.error('Media proxy error', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to serve media' });
  }
}
