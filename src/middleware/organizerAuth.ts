import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';

/**
 * Organizer JWT auth middleware.
 *
 * Reads the same Authorization: Bearer header as adminAuthMiddleware but
 * verifies the token against the ORGANIZER secret (a separate key-space).
 * Attaches the decoded organizer user to `req.organizerUser`.
 *
 * Usage:
 *   router.use(organizerAuthMiddleware);
 *   router.get('/dashboard', (req, res) => {
 *     const user = (req as OrganizerRequest).organizerUser!;
 *     ...
 *   });
 */

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

export function organizerAuthMiddleware(
  req: OrganizerRequest,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    throw new AppError('Unauthorized — organizer token required', 401);
  }

  const token = header.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.organizerSecret) as {
      id: number;
      organizationId: number;
      email: string;
      name: string;
      role: 'owner' | 'manager';
      permissions: Record<string, boolean>;
    };

    req.organizerUser = decoded;
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
    const decoded = jwt.verify(token, config.jwt.organizerSecret) as {
      id: number;
      organizationId: number;
      email: string;
      name: string;
      role: 'owner' | 'manager';
      permissions: Record<string, boolean>;
    };

    if (typeof decoded.id !== 'number') return null;
    if (typeof decoded.organizationId !== 'number') return null;
    if (typeof decoded.email !== 'string') return null;

    return decoded;
  } catch {
    return null;
  }
}
