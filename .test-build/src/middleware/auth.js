"use strict";
/**
 * Customer / user authentication middleware.
 *
 * Session binding (P0-2):
 *   Access tokens carry an optional `session_id` claim.  When present, the
 *   middleware checks a Redis key to determine if the session has been
 *   revoked (logout, logout-all, password change).  This gives immediate
 *   effect to revocation without querying PostgreSQL on every request.
 *
 * Design:
 *   - Redis EXISTS check (~0.3ms) for revocation status
 *   - If Redis is unavailable: fail-open (15-minute token window limits risk)
 *   - If no session_id in JWT: accept (backward-compat for pre-rollout tokens)
 *   - Logout endpoints write to BOTH Redis (fast-path) and PostgreSQL (authoritative)
 *
 * Async middleware: Express calls next() after the async check completes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.revokeSessionInRedis = revokeSessionInRedis;
exports.authMiddleware = authMiddleware;
exports.optionalAuth = optionalAuth;
const errorHandler_1 = require("./errorHandler");
const jwt_1 = require("../utils/jwt");
const redis_1 = require("../db/redis");
const SESSION_REVOKED_PREFIX = 'auth:session:revoked:';
// TTL exceeds max access-token lifetime (15m) + safety buffer
const SESSION_REVOKED_TTL = 1800; // 30 minutes in seconds
/**
 * Mark a session as revoked in Redis (fast propagation to all server instances).
 * Called by logout/revokeSession. The DB is updated separately.
 */
async function revokeSessionInRedis(sessionId) {
    try {
        const redis = (0, redis_1.getRedis)();
        await redis.set(`${SESSION_REVOKED_PREFIX}${sessionId}`, '1', 'EX', SESSION_REVOKED_TTL);
    }
    catch {
        // Redis unavailable — revocation still works via DB update
    }
}
/**
 * Check if a session has been revoked via Redis.
 * Returns true if the session is valid (not revoked).
 * Returns true on any error (fail-open for availability).
 */
async function isSessionValid(sessionId) {
    try {
        const redis = (0, redis_1.getRedis)();
        const redisKey = `${SESSION_REVOKED_PREFIX}${sessionId}`;
        const exists = await redis.exists(redisKey);
        return exists === 0; // 0 = not revoked (valid), 1 = revoked
    }
    catch {
        // Redis unavailable — fail open (15-minute window limits exposure)
        return true;
    }
}
async function authMiddleware(req, _res, next) {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
            throw new errorHandler_1.AppError('Unauthorized', 401);
        }
        const token = header.split(' ')[1];
        const decoded = (0, jwt_1.verifyAccessToken)(token);
        if (!decoded) {
            throw new errorHandler_1.AppError('Invalid or expired token', 401);
        }
        // Session binding: validate session if JWT carries session_id
        if (typeof decoded.session_id === 'number') {
            const sessionValid = await isSessionValid(decoded.session_id);
            if (!sessionValid) {
                throw new errorHandler_1.AppError('Session has been revoked', 401);
            }
        }
        req.user = { id: decoded.id, email: decoded.email };
        next();
    }
    catch (err) {
        next(err instanceof errorHandler_1.AppError ? err : new errorHandler_1.AppError('Invalid or expired token', 401));
    }
}
async function optionalAuth(req, _res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            const token = header.split(' ')[1];
            const decoded = (0, jwt_1.verifyAccessToken)(token);
            if (decoded) {
                req.user = { id: decoded.id, email: decoded.email };
            }
        }
        catch {
            // ignore — optional auth
        }
    }
    next();
}
