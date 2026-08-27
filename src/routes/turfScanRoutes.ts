import { Router } from 'express';
import { verifyTurfTicket, markTurfTicket } from '../controllers/turfScanController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';

const router = Router();

router.use(adminAuthMiddleware);

router.post('/verify', requirePermission('scanner:verify'), (req, res, next) => verifyTurfTicket(req as AdminRequest, res, next));
router.post('/mark', requirePermission('scanner:checkin'), (req, res, next) => markTurfTicket(req as AdminRequest, res, next));

export { router as turfScanRoutes };
