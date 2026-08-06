import { Router } from 'express';
import {
  register,
  login,
  registerEnhanced,
  loginEnhanced,
  verifyEmail,
  resendVerification,
  refreshToken,
  logout,
  logoutAll,
  forgotPassword,
  resetPassword,
  changePassword,
  getMySessions,
  revokeMySession,
  getMe,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/auth';
import { authRateLimiter, resendVerificationLimiter } from '../middleware/rateLimiter';

const router = Router();

// ── Legacy endpoints (kept for backward compat) ──────────────────────────────
router.post('/register', register);
router.post('/login', login);

// ── Enhanced endpoints ──────────────────────────────────────────────────────
router.post('/register-enhanced', authRateLimiter, registerEnhanced);
router.post('/login-enhanced', authRateLimiter, loginEnhanced);
// GET so the verification link in the email is a plain anchor href
router.get('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerificationLimiter, resendVerification);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);
router.post('/logout-all', authMiddleware, logoutAll);

router.post('/forgot-password', authRateLimiter, forgotPassword);
router.post('/reset-password', resetPassword);

router.post('/change-password', authMiddleware, changePassword);

router.get('/me', authMiddleware, getMe);

// Sessions
router.get('/sessions', authMiddleware, getMySessions);
router.post('/sessions/revoke', authMiddleware, revokeMySession);

export default router;