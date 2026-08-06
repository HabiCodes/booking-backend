"use strict";
/**
 * Enhanced JWT utilities — access tokens + refresh tokens.
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
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const ACCESS_EXPIRY = config_1.config.jwt.expiresIn; // e.g. '7d'
const REFRESH_EXPIRY_DAYS = 30; // 30 days
function buildPayload(userId, email) {
    return { id: userId, email };
}
function generateAccessToken(userId, email) {
    return jsonwebtoken_1.default.sign(buildPayload(userId, email), config_1.config.jwt.secret, {
        expiresIn: ACCESS_EXPIRY,
    });
}
function generateRefreshToken(userId, email) {
    const expiresIn = `${REFRESH_EXPIRY_DAYS}d`;
    return jsonwebtoken_1.default.sign(buildPayload(userId, email), config_1.config.jwt.secret, {
        expiresIn: expiresIn,
    });
}
function generateAdminAccessToken(adminId, email, role, permissions) {
    return jsonwebtoken_1.default.sign({ id: adminId, email, role, permissions }, config_1.config.jwt.adminSecret, {
        expiresIn: (config_1.config.jwt.adminExpiresIn ?? '12h'),
    });
}
function verifyAccessToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
        if (typeof decoded.id !== 'number' || typeof decoded.email !== 'string')
            return null;
        return decoded;
    }
    catch {
        return null;
    }
}
function verifyRefreshToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
        if (typeof decoded.id !== 'number' || typeof decoded.email !== 'string')
            return null;
        return decoded;
    }
    catch {
        return null;
    }
}
