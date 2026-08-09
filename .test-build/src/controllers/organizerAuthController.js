"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.refresh = refresh;
const organizerAuthService_1 = require("../services/organizerAuthService");
const errorHandler_1 = require("../middleware/errorHandler");
const validator_1 = require("../middleware/validator");
async function login(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new errorHandler_1.AppError('Email and password are required', 400);
        }
        const result = await organizerAuthService_1.organizerAuthService.login({
            email: (0, validator_1.sanitizeString)(email),
            password,
        });
        res.json({
            success: true,
            data: {
                user: result.user,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            },
        });
    }
    catch (err) {
        return next(err);
    }
}
async function refresh(req, res, next) {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            throw new errorHandler_1.AppError('Refresh token is required', 400);
        }
        const payload = organizerAuthService_1.organizerAuthService.verifyRefreshToken(refreshToken);
        if (!payload) {
            throw new errorHandler_1.AppError('Invalid or expired refresh token', 401);
        }
        const result = await organizerAuthService_1.organizerAuthService.refreshUserTokens(payload.sub);
        if (!result) {
            throw new errorHandler_1.AppError('User not found or inactive', 401);
        }
        res.json({
            success: true,
            data: {
                user: result.user,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
            },
        });
    }
    catch (err) {
        return next(err);
    }
}
