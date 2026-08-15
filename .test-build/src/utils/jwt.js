"use strict";
/**
 * Enhanced JWT utilities — access tokens + refresh tokens.
 *
 * Access tokens carry an optional session_id claim.  When present, the auth
 * middleware validates the session in user_sessions (revoked = false) on each
 * request.  Tokens without session_id are accepted for backward compatibility
 * during the rollout window (they simply skip the session check).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAccessToken = generateAccessToken;
exports.generateRefreshToken = generateRefreshToken;
exports.generateAdminAccessToken = generateAdminAccessToken;
exports.verifyAccessToken = verifyAccessToken;
exports.verifyRefreshToken = verifyRefreshToken;
exports.verifyAdminAccessToken = verifyAdminAccessToken;
exports.verifyOrganizerAccessToken = verifyOrganizerAccessToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const ACCESS_EXPIRY = config_1.config.jwt.expiresIn; // e.g. '15m'
const REFRESH_EXPIRY_DAYS = 30; // 30 days
function buildPayload(userId, email) {
    return { id: userId, sub: email };
}
/**
 * Verify that the JWT payload has the expected token type.
 * Accepts backward-compatible tokens that lack a typ claim.
 */
function verifyTokenType(decoded, expectedType) {
    if (typeof decoded !== 'object' || decoded === null)
        return false;
    if (decoded.typ !== undefined && decoded.typ !== expectedType)
        return false;
    return true;
}
function generateAccessToken(userId, email, sessionId) {
    const payload = { ...buildPayload(userId, email), typ: 'access' };
    if (typeof sessionId === 'number') {
        payload.session_id = sessionId;
    }
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwt.secret, {
        expiresIn: ACCESS_EXPIRY,
    });
}
function generateRefreshToken(userId, email) {
    const expiresIn = `${REFRESH_EXPIRY_DAYS}d`;
    return jsonwebtoken_1.default.sign({ ...buildPayload(userId, email), typ: 'refresh' }, config_1.config.jwt.secret, {
        expiresIn: expiresIn,
    });
}
function generateAdminAccessToken(adminId, email, role, permissions, permissionsUpdatedAt) {
    const payload = { id: adminId, sub: email, typ: 'admin_access', role, permissions };
    if (permissionsUpdatedAt) {
        payload.permissions_updated_at = permissionsUpdatedAt;
    }
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwt.adminSecret, {
        expiresIn: (config_1.config.jwt.adminExpiresIn ?? '12h'),
    });
}
function verifyAccessToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
        if (!verifyTokenType(decoded, 'access'))
            return null;
        if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string')
            return null;
        const sessionId = typeof decoded.session_id === 'number' ? decoded.session_id : undefined;
        return { id: decoded.id, email: decoded.sub, session_id: sessionId };
    }
    catch {
        return null;
    }
}
function verifyRefreshToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
        if (!verifyTokenType(decoded, 'refresh'))
            return null;
        if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string')
            return null;
        return { id: decoded.id, email: decoded.sub };
    }
    catch {
        return null;
    }
}
/**
 * Verify an admin access token, checking type claim and required fields.
 */
function verifyAdminAccessToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.adminSecret);
        if (!verifyTokenType(decoded, 'admin_access'))
            return null;
        if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string')
            return null;
        const role = typeof decoded.role === 'string' ? decoded.role : undefined;
        const permissions = typeof decoded.permissions === 'object' && !Array.isArray(decoded.permissions)
            ? decoded.permissions
            : undefined;
        const permissionsUpdatedAt = typeof decoded.permissions_updated_at === 'string' ? decoded.permissions_updated_at : undefined;
        return { id: decoded.id, email: decoded.sub, role, permissions, permissionsUpdatedAt };
    }
    catch {
        return null;
    }
}
/**
 * Verify an organizer access token, checking type claim and required fields.
 */
function verifyOrganizerAccessToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.organizerSecret);
        if (!verifyTokenType(decoded, 'organizer_access'))
            return null;
        if (typeof decoded.id !== 'number')
            return null;
        if (typeof decoded.sub !== 'string')
            return null;
        if (typeof decoded.organization_id !== 'number')
            return null;
        if (typeof decoded.name !== 'string')
            return null;
        if (decoded.role !== 'owner' && decoded.role !== 'manager')
            return null;
        const permissions = typeof decoded.permissions === 'object' && !Array.isArray(decoded.permissions)
            ? decoded.permissions
            : {};
        return {
            id: decoded.id,
            organizationId: decoded.organization_id,
            email: decoded.sub,
            name: decoded.name,
            role: decoded.role,
            permissions,
        };
    }
    catch {
        return null;
    }
}
