/**
 * Customer / user authentication middleware.
 *
 * Session binding (P0-2):
 *   Access tokens carry an optional `session_id` claim.  When present, the
 *   middleware checks a Redis key to determine if the session has been
 *   revoked (logout, logout-all, password change).  This gives immediate
 *   effect to revocation without querying PostgreSQL on every request.
 *
 * Design:
 *   - Redis EXISTS check (~0.3ms) for revocation status
 *   - If Redis is unavailable: fail-open (15-minute token window limits risk)
 *   - If no session_id in JWT: accept (backward-compat for pre-rollout tokens)
 *   - Logout endpoints write to BOTH Redis (fast-path) and PostgreSQL (authoritative)
 *
 * Async middleware: Express calls next() after the async check completes.
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/jwt';
import { getRedis } from '../db/redis';

const SESSION_REVOKED_PREFIX = 'auth:session:revoked:';
// TTL exceeds max access-token lifetime (15m) + safety buffer
const SESSION_REVOKED_TTL = 1800; // 30 minutes in seconds

export interface AuthRequest extends Request {
  user?: { id: number; email: string };
}

/**
 * Mark a session as revoked in Redis (fast propagation to all server instances).
 * Called by logout/revokeSession. The DB is updated separately.
 */
export async function revokeSessionInRedis(sessionId: number): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`${SESSION_REVOKED_PREFIX}${sessionId}`, '1', 'EX', SESSION_REVOKED_TTL);
  } catch {
    // Redis unavailable — revocation still works via DB update
  }
}

/**
 * Check if a session has been revoked via Redis.
 * Returns true if the session is valid (not revoked).
 * Returns true on any error (fail-open for availability).
 */
async function isSessionValid(sessionId: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const redisKey = `${SESSION_REVOKED_PREFIX}${sessionId}`;
    const exists = await redis.exists(redisKey);
    return exists === 0; // 0 = not revoked (valid), 1 = revoked
  } catch {
    // Redis unavailable — fail open (15-minute window limits exposure)
    return true;
  }
}

export async function authMiddleware(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Unauthorized', 401);
    }

    const token = header.split(' ')[1];
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      throw new AppError('Invalid or expired token', 401);
    }

    // Session binding: validate session if JWT carries session_id
    if (typeof decoded.session_id === 'number') {
      const sessionValid = await isSessionValid(decoded.session_id);
      if (!sessionValid) {
        throw new AppError('Session has been revoked', 401);
      }
    }

    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError('Invalid or expired token', 401));
  }
}

export async function optionalAuth(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const token = header.split(' ')[1];
      const decoded = verifyAccessToken(token);
      if (decoded) {
        req.user = { id: decoded.id, email: decoded.email };
      }
    } catch {
      // ignore — optional auth
    }
  }
  next();
}
