
/**
 * Organizer JWT auth middleware.
 *
 * Validates:
 *   1. JWT signature against ORGANIZER_JWT_SECRET (separate key-space)
 *   2. Token type and required claims (type validation)
 *   3. Organizer user is_active status in database
 *   4. Session not revoked in Redis (server-side revocation)
 *
 * The Redis revocation check closes the gap between DB deactivation and JWT expiry:
 * when a manager is deactivated or their session is revoked, a Redis flag is set
 * that invalidates all existing JWTs immediately (within milliseconds).
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { getPool } from '../db/pool';
import { getRedis } from '../db/redis';
import { verifyOrganizerAccessToken } from '../utils/jwt';

export interface OrganizerRequest extends Request {
  organizerUser?: {
    id: number;
    organizationId: number;
    email: string;
    name: string;
    role: 'owner' | 'manager';
    permissions: Record<string, boolean>;
    assignedVenueIds?: number[];
    jti?: string;
  };
}

const REDIS_REVOCATION_PREFIX = 'org_revoked';
const JWT_TTL_SECONDS = 8 * 3600; // matches ORGANIZER_JWT_EXPIRES_IN default of 8h

async function verifyOrganizerIsActive(userId: number): Promise<{ active: boolean; assignedVenueIds: number[] }> {
  try {
    const { rows } = await getPool().query(
      'SELECT is_active, assigned_venue_ids FROM organizer_users WHERE id = $1 LIMIT 1',
      [userId]
    );
    const row = (rows as Array<{ is_active: boolean; assigned_venue_ids: number[] | null }>)[0];
    if (!row) return { active: false, assignedVenueIds: [] };
    return { active: row.is_active, assignedVenueIds: row.assigned_venue_ids || [] };
  } catch {
    return { active: false, assignedVenueIds: [] };
  }
}

/**
 * Check Redis for a server-side revocation flag.
 * Returns true if the user's sessions have been revoked.
 *
 * Uses key pattern: org_revoked:{userId} = "1" with TTL = JWT expiry.
 * Set during: session revocation, account deactivation, password reset.
 */
async function isSessionRevoked(userId: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const key = `${REDIS_REVOCATION_PREFIX}:${userId}`;
    const result = await redis.exists(key);
    return result === 1;
  } catch {
    // Redis failure: fail OPEN for availability (DB is authoritative)
    return false;
  }
}

/**
 * Revoke all active sessions for a user in Redis.
 * This immediately invalidates all existing JWTs for the user.
 */
export async function revokeOrganizerSessionsRedis(userId: number): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${REDIS_REVOCATION_PREFIX}:${userId}`;
    await redis.set(key, '1', 'EX', JWT_TTL_SECONDS);
  } catch {
    // Log but don't fail — DB revocation already happened
  }
}

/**
 * Clear the Redis revocation flag for a user (called on successful login).
 */
export async function clearOrganizerRevocationRedis(userId: number): Promise<void> {
  try {
    const redis = getRedis();
    const key = `${REDIS_REVOCATION_PREFIX}:${userId}`;
    await redis.del(key);
  } catch {
    // Non-fatal
  }
}

export async function organizerAuthMiddleware(
  req: OrganizerRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Unauthorized — organizer token required', 401));
  }

  const token = header.split(' ')[1];

  try {
    const payload = verifyOrganizerAccessToken(token);
    if (!payload) {
      return next(new AppError('Invalid organizer token structure', 401));
    }

    // Check Redis revocation flag (server-side session invalidation)
    const revoked = await isSessionRevoked(payload.id);
    if (revoked) {
      return next(new AppError('Session has been revoked — please log in again', 401));
    }

    // Verify organizer user is still active in DB + load venue assignments
    const { active, assignedVenueIds } = await verifyOrganizerIsActive(payload.id);
    if (!active) {
      return next(new AppError('Organizer account has been deactivated', 401));
    }

    req.organizerUser = {
      ...payload,
      assignedVenueIds,
    };
    next();
  } catch {
    // Catches: verifyOrganizerAccessToken returning null, isSessionRevoked rejecting,
    // verifyOrganizerIsActive rejecting, or any unexpected error — all route to 401
    // to avoid leaking internals.
    next(new AppError('Invalid or expired organizer token', 401));
  }
}

/**
 * Convenience: verify an organizer token and return the decoded payload
 * (or null on failure). Used by the login controller to issue tokens.
 */
export function verifyOrganizerToken(token: string): OrganizerRequest['organizerUser'] | null {
  try {
    return verifyOrganizerAccessToken(token);
  } catch {
    return null;
  }
}
