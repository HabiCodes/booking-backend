import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AuthRequest } from '../middleware/auth';
import { bookingRateLimiter, paymentRateLimiter } from '../infrastructure/distributedRateLimiter';
import { createBooking, cancelBooking, getMyBookings, getBookingPdf, getBookingDetails, verifyPayment } from '../controllers/bookingController';

const router = Router();

router.use(authMiddleware);

router.post('/', bookingRateLimiter, (req: AuthRequest, res, next) => createBooking(req, res, next));
router.post('/:id/cancel', bookingRateLimiter, (req: AuthRequest, res, next) => cancelBooking(req, res, next));
router.get('/my', (req: AuthRequest, res, next) => getMyBookings(req, res, next));
router.get('/:id', (req: AuthRequest, res, next) => getBookingDetails(req, res, next));
router.get('/:id/pdf', (req: AuthRequest, res, next) => getBookingPdf(req, res, next));
// Payment verification after returning from gateway (mirrors turf and movie patterns)
router.post('/:id/verify', paymentRateLimiter, (req: AuthRequest, res, next) => verifyPayment(req, res, next));

export default router;
