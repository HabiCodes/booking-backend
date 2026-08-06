"use strict";
/**
 * Permission middleware factory.
 *
 *   router.post('/', adminAuthMiddleware, requirePermission('events:write'), handler);
 *
 * The factory returns a middleware that 403s if `req.admin.permissions[perm]` is not true.
 * Super admins (`role === 'super_admin'`) always pass — checked first.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirePermission = requirePermission;
const errorHandler_1 = require("./errorHandler");
const permissions_1 = require("../rbac/permissions");
function requirePermission(...perms) {
    if (perms.length === 0) {
        throw new Error('requirePermission() needs at least one permission key');
    }
    return (req, _res, next) => {
        if (!req.admin)
            return next(new errorHandler_1.AppError('Unauthorized', 401));
        if (req.admin.role === 'super_admin')
            return next();
        if (!(0, permissions_1.hasAllPermissions)(req.admin.permissions, perms)) {
            return next(new errorHandler_1.AppError(`Forbidden — missing permission: ${perms.join(', ')}`, 403));
        }
        return next();
    };
}
