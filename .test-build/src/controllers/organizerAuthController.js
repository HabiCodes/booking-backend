"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.setupPassword = setupPassword;
exports.refresh = refresh;
const organizerAuthService_1 = require("../services/organizerAuthService");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
const organizerPasswordTokenService_1 = require("../services/organizerPasswordTokenService");
const errorHandler_1 = require("../middleware/errorHandler");
const validator_1 = require("../middleware/validator");
const passwordPolicy_1 = require("../utils/passwordPolicy");
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
async function setupPassword(req, res, next) {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            throw new errorHandler_1.AppError('token and password are required', 400);
        }
        // Enforce the full password policy (same as regular registration)
        const policyCheck = (0, passwordPolicy_1.validatePassword)(password, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyCheck.valid) {
            throw new errorHandler_1.AppError(`Password does not meet requirements: ${policyCheck.errors.join(', ')}`, 400);
        }
        // Consume the token and set password
        const result = await organizerPasswordTokenService_1.organizerPasswordTokenService.consume(token, password);
        // Get user for response
        const user = await organizerUserRepository_1.organizerUserRepository.findById(result.userId);
        if (!user) {
            throw new errorHandler_1.AppError('User not found after password setup', 404);
        }
        // Issue JWT so the owner can immediately log in
        const loginResult = await organizerAuthService_1.organizerAuthService.login({
            email: user.email,
            password,
        });
        res.json({
            success: true,
            message: 'Password set successfully',
            data: {
                user: loginResult.user,
                accessToken: loginResult.accessToken,
                refreshToken: loginResult.refreshToken,
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
