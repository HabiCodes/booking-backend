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
  verifyRegistrationOtp,
  resendRegistrationOtp,
  updateProfile,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/auth';
import { authRateLimiter, resendVerificationLimiter, otpVerifyLimiter } from '../infrastructure/distributedRateLimiter';

const router = Router();

// ── Legacy endpoints (kept for backward compat) ──────────────────────────────
router.post('/register', register);
router.post('/login', authRateLimiter, login);

// ── Enhanced endpoints ──────────────────────────────────────────────────────
router.post('/register-enhanced', authRateLimiter, registerEnhanced);
router.post('/login-enhanced', authRateLimiter, loginEnhanced);
// GET so the verification link in the email is a plain anchor href
router.get('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerificationLimiter, resendVerification);

// ── OTP Registration (preferred new flow) ───────────────────────────────────
router.post('/register-otp', authRateLimiter, registerEnhanced);
router.post('/verify-registration-otp', otpVerifyLimiter, verifyRegistrationOtp);
router.post('/resend-registration-otp', resendVerificationLimiter, resendRegistrationOtp);
router.post('/refresh-token', authRateLimiter, refreshToken);
router.post('/logout', authRateLimiter, logout);
router.post('/logout-all', authMiddleware, authRateLimiter, logoutAll);

router.post('/forgot-password', authRateLimiter, forgotPassword);
router.post('/reset-password', authRateLimiter, resetPassword);

router.post('/change-password', authMiddleware, authRateLimiter, changePassword);

router.patch('/me', authMiddleware, updateProfile);
router.get('/me', authMiddleware, getMe);

// Sessions
router.get('/sessions', authMiddleware, getMySessions);
router.post('/sessions/revoke', authMiddleware, revokeMySession);

export default router;