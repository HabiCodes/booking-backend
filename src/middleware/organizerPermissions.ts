import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { OrganizerRequest } from './organizerAuth';

/**
 * Require an organizer-specific permission.
 *
 * Reads the permission set from `req.organizerUser.permissions` (JSONB array
 * of allowed keys) and passes if the required key is present.
 *
 * Usage:
 *   router.get('/events',
 *     organizerAuthMiddleware,
 *     requireOrganizerPermission('organizer:events:read'),
 *     (req, res) => { ... }
 *   );
 */
export function requireOrganizerPermission(permission: string) {
  return (req: OrganizerRequest, _res: Response, next: NextFunction): void => {
    const user = req.organizerUser;

    if (!user) {
      throw new AppError('Unauthorized', 401);
    }

    const perms: Record<string, boolean> = user.permissions || {};
    if (!perms[permission]) {
      throw new AppError(`Missing permission: ${permission}`, 403);
    }

    next();
  };
}

/**
 * Re-exports role/permission guards from organizerPermissionMiddleware so
 * existing imports of `requireOwner`, `requireAnyPermission`, etc. continue
 * to work from `../middleware/organizerPermissions`.
 */
export {
  requireOwner,
  requireRole,
  requireAnyPermission,
  requireAllPermissions,
  requireOrgOwner,
} from './organizerPermissionMiddleware';

/**
 * Convenience: check whether the organizer user has a specific permission
 * (returns boolean — useful inside handlers).
 */
export function organizerHasPermission(
  req: OrganizerRequest,
  permission: string
): boolean {
  const perms: Record<string, boolean> = req.organizerUser?.permissions || {};
  return !!perms[permission];
}
