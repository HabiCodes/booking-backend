/**
 * Permission middleware factory.
 *
 *   router.post('/', adminAuthMiddleware, requirePermission('events:write'), handler);
 *
 * The factory returns a middleware that 403s if `req.admin.permissions[perm]` is not true.
 * Super admins (`role === 'super_admin'`) always pass — checked first.
 */

import { type Request, type Response, type NextFunction } from 'express';
import { AppError } from './errorHandler';
import { AdminRequest } from './adminAuth';
import { hasAllPermissions } from '../rbac/permissions';

export function requirePermission(...perms: string[]) {
  if (perms.length === 0) {
    throw new Error('requirePermission() needs at least one permission key');
  }
  return (req: AdminRequest, _res: Response, next: NextFunction): void => {
    if (!req.admin) return next(new AppError('Unauthorized', 401));
    if (req.admin.role === 'super_admin') return next();
    if (!hasAllPermissions(req.admin.permissions, perms)) {
      return next(new AppError(`Forbidden — missing permission: ${perms.join(', ')}`, 403));
    }
    return next();
  };
}

/** Loose typing for any admin-aware request. Re-exported so other modules don't depend on adminAuth.ts. */
export type { AdminRequest } from './adminAuth';
