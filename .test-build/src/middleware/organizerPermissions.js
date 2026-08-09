"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireOrganizerPermission = requireOrganizerPermission;
exports.organizerHasPermission = organizerHasPermission;
const errorHandler_1 = require("./errorHandler");
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
function requireOrganizerPermission(permission) {
    return (req, _res, next) => {
        const user = req.organizerUser;
        if (!user) {
            throw new errorHandler_1.AppError('Unauthorized', 401);
        }
        const perms = user.permissions || {};
        if (!perms[permission]) {
            throw new errorHandler_1.AppError(`Missing permission: ${permission}`, 403);
        }
        next();
    };
}
/**
 * Convenience: check whether the organizer user has a specific permission
 * (returns boolean — useful inside handlers).
 */
function organizerHasPermission(req, permission) {
    const perms = req.organizerUser?.permissions || {};
    return !!perms[permission];
}
