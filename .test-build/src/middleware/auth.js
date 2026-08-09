"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.optionalAuth = optionalAuth;
const errorHandler_1 = require("./errorHandler");
const jwt_1 = require("../utils/jwt");
function authMiddleware(req, _res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        throw new errorHandler_1.AppError('Unauthorized', 401);
    }
    try {
        const token = header.split(' ')[1];
        const decoded = (0, jwt_1.verifyAccessToken)(token);
        if (!decoded) {
            throw new errorHandler_1.AppError('Invalid or expired token', 401);
        }
        req.user = { id: decoded.id, email: decoded.email };
        next();
    }
    catch {
        throw new errorHandler_1.AppError('Invalid or expired token', 401);
    }
}
function optionalAuth(req, _res, next) {
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
