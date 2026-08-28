import { Router } from 'express';
import { verifyTicket, markTicket } from '../controllers/scanController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { requireScannerAuthorization } from '../middleware/scannerAuth';

const router = Router();

router.use(adminAuthMiddleware);
router.use(requireScannerAuthorization);

router.post('/verify', requirePermission('scanner:verify'), (req, res, next) => verifyTicket(req as AdminRequest, res, next));
router.post('/mark', requirePermission('scanner:checkin'), (req, res, next) => markTicket(req as AdminRequest, res, next));

export default router;
