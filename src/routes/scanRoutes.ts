import { Router } from 'express';
import { verifyTicket, markTicket } from '../controllers/scanController';
import { adminAuthMiddleware } from '../middleware/adminAuth';

const router = Router();

router.use(adminAuthMiddleware);

router.post('/verify', (req, res, next) => verifyTicket(req, res, next));
router.post('/mark', (req, res, next) => markTicket(req, res, next));

export default router;
