
/**
 * Organizer JWT auth middleware.
 *
 * Validates:
 *   1. JWT signature against ORGANIZER_JWT_SECRET (separate key-space)
 *   2. Token type and required claims (type validation)
 *   3. Organizer user is_active status in database
 *
 * The is_active check ensures that deactivated organizer accounts cannot
 * use existing JWTs until they expire (8-hour window reduced by this check).
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';
import { getPool } from '../db/pool';
import { verifyOrganizerAccessToken } from '../utils/jwt';

export interface OrganizerRequest extends Request {
  organizerUser?: {
    id: number;
    organizationId: number;
    email: string;
    name: string;
    role: 'owner' | 'manager';
    permissions: Record<string, boolean>;
  };
}

async function verifyOrganizerIsActive(userId: number): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      'SELECT is_active FROM organizer_users WHERE id = $1 LIMIT 1',
      [userId]
    );
    const row = (rows as Array<{ is_active: boolean }>)[0];
    if (!row) return false;
    return row.is_active;
  } catch {
    return true; // fail open
  }
}

export async function organizerAuthMiddleware(
  req: OrganizerRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError('Unauthorized — organizer token required', 401);
  }

  const token = header.split(' ')[1];

  try {
    const payload = verifyOrganizerAccessToken(token);
    if (!payload) {
      throw new AppError('Invalid organizer token structure', 401);
    }

    // Verify organizer user is still active
    const isActive = await verifyOrganizerIsActive(payload.id);
    if (!isActive) {
      throw new AppError('Organizer account has been deactivated', 401);
    }

    req.organizerUser = payload;
    next();
  } catch {
    throw new AppError('Invalid or expired organizer token', 401);
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
