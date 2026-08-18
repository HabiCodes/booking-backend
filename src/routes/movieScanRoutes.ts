import { Router } from 'express';
import { verifyMovieTicket, markMovieTicket } from '../controllers/movieScanController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';

const router = Router();

router.use(adminAuthMiddleware);

router.post('/verify', requirePermission('scanner:verify'), (req, res, next) => verifyMovieTicket(req as AdminRequest, res, next));
router.post('/mark', requirePermission('scanner:checkin'), (req, res, next) => markMovieTicket(req as AdminRequest, res, next));

export { router as movieScanRoutes };
