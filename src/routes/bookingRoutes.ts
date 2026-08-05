import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { createBooking, getMyBookings, getBookingPdf, getBookingDetails } from '../controllers/bookingController';

const router = Router();

router.use(authMiddleware);

router.post('/', (req: AuthRequest, res, next) => createBooking(req, res, next));
router.get('/my', (req: AuthRequest, res, next) => getMyBookings(req, res, next));
router.get('/:id', (req: AuthRequest, res, next) => getBookingDetails(req, res, next));
router.get('/:id/pdf', (req: AuthRequest, res, next) => getBookingPdf(req, res, next));

export default router;
