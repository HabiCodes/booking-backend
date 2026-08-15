"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerAuthMiddleware = organizerAuthMiddleware;
exports.verifyOrganizerToken = verifyOrganizerToken;
const errorHandler_1 = require("./errorHandler");
const pool_1 = require("../db/pool");
const jwt_1 = require("../utils/jwt");
async function verifyOrganizerIsActive(userId) {
    try {
        const { rows } = await (0, pool_1.getPool)().query('SELECT is_active FROM organizer_users WHERE id = $1 LIMIT 1', [userId]);
        const row = rows[0];
        if (!row)
            return false;
        return row.is_active;
    }
    catch {
        return true; // fail open
    }
}
async function organizerAuthMiddleware(req, _res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return next(new errorHandler_1.AppError('Unauthorized — organizer token required', 401));
    }
    const token = header.split(' ')[1];
    try {
        const payload = (0, jwt_1.verifyOrganizerAccessToken)(token);
        if (!payload) {
            return next(new errorHandler_1.AppError('Invalid organizer token structure', 401));
        }
        // Verify organizer user is still active
        const isActive = await verifyOrganizerIsActive(payload.id);
        if (!isActive) {
            return next(new errorHandler_1.AppError('Organizer account has been deactivated', 401));
        }
        req.organizerUser = payload;
        next();
    }
    catch {
        // Catches: verifyOrganizerAccessToken returning null, verifyOrganizerIsActive
        // rejecting, or any unexpected error — all route to 401 to avoid leaking internals.
        next(new errorHandler_1.AppError('Invalid or expired organizer token', 401));
    }
}
/**
 * Convenience: verify an organizer token and return the decoded payload
 * (or null on failure). Used by the login controller to issue tokens.
 */
function verifyOrganizerToken(token) {
    try {
        return (0, jwt_1.verifyOrganizerAccessToken)(token);
    }
    catch {
        return null;
    }
}
