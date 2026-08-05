import { Router } from 'express';
import { adminStats, adminBookings, adminRecentTickets } from '../controllers/adminController';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import { AdminRequest } from '../middleware/adminAuth';

const router = Router();

router.use(adminAuthMiddleware);

router.get('/stats', (req: AdminRequest, res, next) => adminStats(req, res, next));
router.get('/bookings', (req: AdminRequest, res, next) => adminBookings(req, res, next));
router.get('/recent-tickets', (req: AdminRequest, res, next) => adminRecentTickets(req, res, next));

export default router;
