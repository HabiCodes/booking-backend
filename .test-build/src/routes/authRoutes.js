"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const auth_1 = require("../middleware/auth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// ── Legacy endpoints (kept for backward compat) ──────────────────────────────
router.post('/register', authController_1.register);
router.post('/login', authController_1.login);
// ── Enhanced endpoints ──────────────────────────────────────────────────────
router.post('/register-enhanced', rateLimiter_1.authRateLimiter, authController_1.registerEnhanced);
router.post('/login-enhanced', rateLimiter_1.authRateLimiter, authController_1.loginEnhanced);
router.post('/verify-email', authController_1.verifyEmail);
router.post('/resend-verification', rateLimiter_1.authRateLimiter, authController_1.resendVerification);
router.post('/refresh-token', authController_1.refreshToken);
router.post('/logout', authController_1.logout);
router.post('/logout-all', auth_1.authMiddleware, authController_1.logoutAll);
router.post('/forgot-password', rateLimiter_1.authRateLimiter, authController_1.forgotPassword);
router.post('/reset-password', authController_1.resetPassword);
router.post('/change-password', auth_1.authMiddleware, authController_1.changePassword);
// Sessions
router.get('/sessions', auth_1.authMiddleware, authController_1.getMySessions);
router.post('/sessions/revoke', auth_1.authMiddleware, authController_1.revokeMySession);
exports.default = router;
