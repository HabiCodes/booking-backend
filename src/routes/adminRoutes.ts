import { Router } from 'express';
import { adminLogin } from '../controllers/adminController';
import { rateLimiter } from '../middleware/rateLimiter';

const adminLoginLimiter = rateLimiter({
  windowMs: 15 * 60_000, // 15 minutes
  max: 10,
  message: 'Too many admin login attempts. Please try again later.',
});

const router = Router();

router.post('/login', adminLoginLimiter, adminLogin);

export default router;
