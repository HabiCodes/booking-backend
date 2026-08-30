/**
 * Admin JWT authentication middleware.
 *
 * Validates:
 *   1. JWT signature against ADMIN_JWT_SECRET
 *   2. Token type and required claims (type validation)
 *   3. Admin account is_active status in database
 *   4. Permissions freshness via permissions_updated_at versioning (P1-2)
 *
 * The is_active check ensures that deactivated admin accounts cannot use
 * existing JWTs until they expire (12-hour window reduced by this check).
 *
 * The permissions_updated_at check ensures that permission changes take effect
 * immediately without waiting for JWT expiry. The admin JWT payload includes
 * the permissions_updated_at timestamp; the middleware compares it against the
 * current DB value.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';
import { getPool } from '../db/pool';
import { verifyAdminAccessToken } from '../utils/jwt';

export interface AdminRequest extends Request {
  admin?: {
    id: number;
    email: string;
    role?: string;
    permissions?: Record<string, boolean>;
    permissionsUpdatedAt?: string;
    organizationId?: number | null;  // null = super-admin (all orgs), non-null = org-scoped
  };
}

/**
 * Validate the structure of a decoded admin JWT payload.
 * Rejects tokens with missing or mistyped required claims.
 */
function validateAdminPayload(decoded: unknown): { id: number; email: string; role?: string; permissions?: Record<string, boolean>; permissionsUpdatedAt?: string } | null {
  if (typeof decoded !== 'object' || decoded === null) return null;
  const d = decoded as Record<string, unknown>;
  if (typeof d.id !== 'number') return null;
  if (typeof d.sub !== 'string') return null;
  if (d.role !== undefined && typeof d.role !== 'string') return null;
  if (d.permissions !== undefined && typeof d.permissions !== 'object' && !Array.isArray(d.permissions)) return null;
  if (d.permissions_updated_at !== undefined && typeof d.permissions_updated_at !== 'string') return null;
  return {
    id: d.id,
    email: d.sub,
    role: typeof d.role === 'string' ? d.role : undefined,
    permissions: typeof d.permissions === 'object' && !Array.isArray(d.permissions)
      ? d.permissions as Record<string, boolean>
      : undefined,
    permissionsUpdatedAt: typeof d.permissions_updated_at === 'string' ? d.permissions_updated_at : undefined,
  };
}

async function verifyAdminIsActive(adminId: number): Promise<boolean> {
  try {
    const { rows } = await getPool().query(
      'SELECT is_active FROM admins WHERE id = $1 LIMIT 1',
      [adminId]
    );
    const row = (rows as Array<{ is_active: boolean }>)[0];
    if (!row) return false;
    return row.is_active;
  } catch {
    return false; // fail closed — DB error means we cannot verify, deny access
  }
}

async function verifyPermissionsFreshness(adminId: number, tokenUpdatedAt?: string): Promise<boolean> {
  if (!tokenUpdatedAt) return true; // No timestamp in token = skip check (backward compat)

  try {
    const { rows } = await getPool().query(
      'SELECT permissions_updated_at FROM admins WHERE id = $1 LIMIT 1',
      [adminId]
    );
    const row = (rows as Array<{ permissions_updated_at: Date }>)[0];
    if (!row) return false;
    const dbTimestamp = row.permissions_updated_at.toISOString();
    return dbTimestamp <= tokenUpdatedAt;
  } catch {
    return false; // fail closed — DB error means we cannot verify freshness, deny access
  }
}

export async function adminAuthMiddleware(
  req: AdminRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Unauthorized', 401));
  }

  const token = header.split(' ')[1];

  try {
    const decoded = verifyAdminAccessToken(token);
    if (!decoded) {
      return next(new AppError('Invalid admin token structure', 401));
    }

    // Verify admin account is still active
    const isActive = await verifyAdminIsActive(decoded.id);
    if (!isActive) {
      return next(new AppError('Admin account has been deactivated', 401));
    }

    // Verify permissions are fresh (P1-2)
    const permissionsFresh = await verifyPermissionsFreshness(decoded.id, decoded.permissionsUpdatedAt);
    if (!permissionsFresh) {
      return next(new AppError('Permissions have been updated — please re-authenticate', 401));
    }

    // Load organization_id for scanner authorization
    let organizationId: number | null = null;
    const { rows } = await getPool().query(
      'SELECT organization_id FROM admins WHERE id = $1 LIMIT 1',
      [decoded.id]
    );
    const row = (rows as Array<{ organization_id: number | null }>)[0];
    organizationId = row?.organization_id ?? null;

    req.admin = { ...decoded, organizationId };
    next();
  } catch {
    next(new AppError('Invalid or expired admin token', 401));
  }
}
