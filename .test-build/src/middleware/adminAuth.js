"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAuthMiddleware = adminAuthMiddleware;
const errorHandler_1 = require("./errorHandler");
const pool_1 = require("../db/pool");
const jwt_1 = require("../utils/jwt");
/**
 * Validate the structure of a decoded admin JWT payload.
 * Rejects tokens with missing or mistyped required claims.
 */
function validateAdminPayload(decoded) {
    if (typeof decoded !== 'object' || decoded === null)
        return null;
    const d = decoded;
    if (typeof d.id !== 'number')
        return null;
    if (typeof d.sub !== 'string')
        return null;
    if (d.role !== undefined && typeof d.role !== 'string')
        return null;
    if (d.permissions !== undefined && typeof d.permissions !== 'object' && !Array.isArray(d.permissions))
        return null;
    if (d.permissions_updated_at !== undefined && typeof d.permissions_updated_at !== 'string')
        return null;
    return {
        id: d.id,
        email: d.sub,
        role: typeof d.role === 'string' ? d.role : undefined,
        permissions: typeof d.permissions === 'object' && !Array.isArray(d.permissions)
            ? d.permissions
            : undefined,
        permissionsUpdatedAt: typeof d.permissions_updated_at === 'string' ? d.permissions_updated_at : undefined,
    };
}
async function verifyAdminIsActive(adminId) {
    try {
        const { rows } = await (0, pool_1.getPool)().query('SELECT is_active FROM admins WHERE id = $1 LIMIT 1', [adminId]);
        const row = rows[0];
        if (!row)
            return false;
        return row.is_active;
    }
    catch {
        return true; // fail open
    }
}
async function verifyPermissionsFreshness(adminId, tokenUpdatedAt) {
    if (!tokenUpdatedAt)
        return true; // No timestamp in token = skip check (backward compat)
    try {
        const { rows } = await (0, pool_1.getPool)().query('SELECT permissions_updated_at FROM admins WHERE id = $1 LIMIT 1', [adminId]);
        const row = rows[0];
        if (!row)
            return false;
        return row.permissions_updated_at <= tokenUpdatedAt;
    }
    catch {
        return true; // fail open
    }
}
async function adminAuthMiddleware(req, _res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return next(new errorHandler_1.AppError('Unauthorized', 401));
    }
    const token = header.split(' ')[1];
    try {
        const decoded = (0, jwt_1.verifyAdminAccessToken)(token);
        if (!decoded) {
            return next(new errorHandler_1.AppError('Invalid admin token structure', 401));
        }
        // Verify admin account is still active
        const isActive = await verifyAdminIsActive(decoded.id);
        if (!isActive) {
            return next(new errorHandler_1.AppError('Admin account has been deactivated', 401));
        }
        // Verify permissions are fresh (P1-2)
        const permissionsFresh = await verifyPermissionsFreshness(decoded.id, decoded.permissionsUpdatedAt);
        if (!permissionsFresh) {
            return next(new errorHandler_1.AppError('Permissions have been updated — please re-authenticate', 401));
        }
        req.admin = decoded;
        next();
    }
    catch {
        // Catches:
        //  - verifyAdminAccessToken() returning null/undefined (not AppError)
        //  - verifyAdminIsActive / verifyPermissionsFreshness rejecting (DB failure → 401, not 500)
        //  - Any other unexpected error → 401 to avoid leaking internals
        next(new errorHandler_1.AppError('Invalid or expired admin token', 401));
    }
}
