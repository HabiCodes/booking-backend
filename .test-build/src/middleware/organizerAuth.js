"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerAuthMiddleware = organizerAuthMiddleware;
exports.verifyOrganizerToken = verifyOrganizerToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const errorHandler_1 = require("./errorHandler");
function organizerAuthMiddleware(req, _res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        throw new errorHandler_1.AppError('Unauthorized — organizer token required', 401);
    }
    const token = header.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.organizerSecret);
        req.organizerUser = decoded;
        next();
    }
    catch {
        throw new errorHandler_1.AppError('Invalid or expired organizer token', 401);
    }
}
/**
 * Convenience: verify an organizer token and return the decoded payload
 * (or null on failure). Used by the login controller to issue tokens.
 */
function verifyOrganizerToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.organizerSecret);
        if (typeof decoded.id !== 'number')
            return null;
        if (typeof decoded.organizationId !== 'number')
            return null;
        if (typeof decoded.email !== 'string')
            return null;
        return decoded;
    }
    catch {
        return null;
    }
}
