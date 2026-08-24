import { Router } from 'express';
import {
  login as organizerLogin,
  refresh as organizerRefresh,
  setupPassword as organizerSetupPassword,
} from '../controllers/organizerAuthController';
import { authRateLimiter } from '../infrastructure/distributedRateLimiter';

const router = Router();

// Login and refresh share the auth limiter (stricter than global)
router.post('/login', authRateLimiter, organizerLogin);
router.post('/refresh', authRateLimiter, organizerRefresh);

// Setup-password is a one-time token redemption — tighten further to prevent brute-force
router.post('/setup-password', authRateLimiter, organizerSetupPassword);

export default router;
