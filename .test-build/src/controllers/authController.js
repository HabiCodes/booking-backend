"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
exports.login = login;
exports.registerEnhanced = registerEnhanced;
exports.loginEnhanced = loginEnhanced;
exports.verifyEmail = verifyEmail;
exports.resendVerification = resendVerification;
exports.refreshToken = refreshToken;
exports.logout = logout;
exports.logoutAll = logoutAll;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
exports.getMe = getMe;
exports.changePassword = changePassword;
exports.getMySessions = getMySessions;
exports.revokeMySession = revokeMySession;
const authService_1 = require("../services/authService");
const userRepository_1 = require("../repositories/userRepository");
const errorHandler_1 = require("../middleware/errorHandler");
const validator_1 = require("../middleware/validator");
// ── Legacy endpoints (backward compatible) ──────────────────────────────────
async function register(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            throw new errorHandler_1.AppError('Email and password are required', 400);
        if (!(0, validator_1.validateEmail)(email))
            throw new errorHandler_1.AppError('Invalid email format', 400);
        if (password.length < 8)
            throw new errorHandler_1.AppError('Password must be at least 8 characters', 400);
        const result = await authService_1.authService.register((0, validator_1.sanitizeString)(email), password);
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        return next(err);
    }
}
async function login(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            throw new errorHandler_1.AppError('Email and password are required', 400);
        const result = await authService_1.authService.login((0, validator_1.sanitizeString)(email), password);
        res.json({ success: true, data: result });
    }
    catch (err) {
        return next(err);
    }
}
// ── Enhanced endpoints ──────────────────────────────────────────────────────
async function registerEnhanced(req, res, next) {
    try {
        const { email, username, password } = req.body;
        if (!email || !password)
            throw new errorHandler_1.AppError('Email and password are required', 400);
        if (!(0, validator_1.validateEmail)(email))
            throw new errorHandler_1.AppError('Invalid email format', 400);
        const result = await authService_1.authService.registerWithVerification((0, validator_1.sanitizeString)(email), username ? (0, validator_1.sanitizeString)(username) : null, password);
        res.status(201).json({
            success: true,
            data: result,
            message: 'Account created. Please check your email to verify your account.',
        });
    }
    catch (err) {
        return next(err);
    }
}
async function loginEnhanced(req, res, next) {
    try {
        const { email, password, deviceInfo } = req.body;
        if (!email || !password)
            throw new errorHandler_1.AppError('Email and password are required', 400);
        const result = await authService_1.authService.login((0, validator_1.sanitizeString)(email), password, deviceInfo ?? null, req.ip ?? null);
        res.json({ success: true, data: result });
    }
    catch (err) {
        return next(err);
    }
}
async function verifyEmail(req, res, next) {
    try {
        // GET /api/v1/auth/verify-email?token=... — token comes from the query
        // string so the endpoint can be triggered from the email link.
        const rawToken = req.query.token ?? req.body?.token;
        if (!rawToken)
            throw new errorHandler_1.AppError('Verification token is required. Use ?token=...', 400);
        const result = await authService_1.authService.verifyEmail(rawToken);
        if (!result.success) {
            return res.status(400).json({ success: false, message: result.message });
        }
        return res.json({ success: true, message: result.message });
    }
    catch (err) {
        return next(err);
    }
}
async function resendVerification(req, res, next) {
    try {
        const { email } = req.body;
        if (!email)
            throw new errorHandler_1.AppError('Email is required', 400);
        const result = await authService_1.authService.resendVerification((0, validator_1.sanitizeString)(email));
        res.json({ success: true, message: result.message });
    }
    catch (err) {
        return next(err);
    }
}
async function refreshToken(req, res, next) {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken)
            throw new errorHandler_1.AppError('Refresh token is required', 400);
        const tokens = await authService_1.authService.refreshTokens(refreshToken);
        res.json({ success: true, data: tokens });
    }
    catch (err) {
        return next(err);
    }
}
async function logout(req, res, next) {
    try {
        const { refreshToken } = req.body;
        if (refreshToken) {
            await authService_1.authService.logoutCurrentDevice(refreshToken);
        }
        res.json({ success: true, message: 'Logged out successfully' });
    }
    catch (err) {
        return next(err);
    }
}
async function logoutAll(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const result = await authService_1.authService.logoutAllDevices(userId);
        res.json({
            success: true,
            message: `Logged out from all devices`,
            data: result,
        });
    }
    catch (err) {
        return next(err);
    }
}
async function forgotPassword(req, res, next) {
    try {
        const { email } = req.body;
        if (!email)
            throw new errorHandler_1.AppError('Email is required', 400);
        // Always return success to prevent email enumeration
        await authService_1.authService.requestPasswordReset((0, validator_1.sanitizeString)(email));
        res.json({ success: true, message: 'If an account with that email exists, a password reset link has been sent.' });
    }
    catch (err) {
        return next(err);
    }
}
async function resetPassword(req, res, next) {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            throw new errorHandler_1.AppError('Token and new password are required', 400);
        }
        if (newPassword.length < 8) {
            throw new errorHandler_1.AppError('Password must be at least 8 characters', 400);
        }
        await authService_1.authService.resetPassword(token, newPassword);
        res.json({ success: true, message: 'Password reset successful. Please log in with your new password.' });
    }
    catch (err) {
        next(err);
    }
}
async function getMe(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const user = await userRepository_1.userRepository.findById(userId);
        if (!user)
            throw new errorHandler_1.AppError('User not found', 404);
        res.json({ success: true, data: user });
    }
    catch (err) {
        next(err);
    }
}
async function changePassword(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            throw new errorHandler_1.AppError('Current password and new password are required', 400);
        }
        await authService_1.authService.changePassword(userId, currentPassword, newPassword);
        res.json({ success: true, message: 'Password changed successfully' });
    }
    catch (err) {
        return next(err);
    }
}
async function getMySessions(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const sessions = await authService_1.authService.getMySessions(userId);
        res.json({ success: true, data: sessions });
    }
    catch (err) {
        return next(err);
    }
}
async function revokeMySession(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const { sessionId } = req.body;
        if (!sessionId)
            throw new errorHandler_1.AppError('Session ID is required', 400);
        await authService_1.authService.revokeSession(sessionId);
        res.json({ success: true, message: 'Session revoked' });
    }
    catch (err) {
        return next(err);
    }
}
