import { Router, Request, Response, NextFunction } from 'express';
import {
  listMovies, getMovie, getFeaturedMovies, getGenres, getLanguages,
  listCinemas, getCinema, getCinemasByCity, getScreens,
  listShowtimes, getShowtime, getCitiesWithMovies,
} from '../controllers/movieController';
import {
  calculatePrices, holdSeats, releaseSeats,
  createBooking, confirmBooking, getBooking,
  listMyBookings, cancelBooking,
  getMyTickets, verifyTicket, checkHold,
} from '../controllers/movieBookingController';
import { movieBookingService } from '../services/movieBookingService';
import { authMiddleware } from '../middleware/auth';
import { bookingRateLimiter } from '../infrastructure/distributedRateLimiter';
import type { AuthRequest } from '../middleware/auth';

const router = Router();

// ── Movies (public) ───────────────────────────────────────────────────────────

router.get('/movies', listMovies);
router.get('/movies/featured', getFeaturedMovies);
router.get('/movies/genres', getGenres);
router.get('/movies/languages', getLanguages);
router.get('/movies/:slugOrId', getMovie);

// ── Cinemas (public) ──────────────────────────────────────────────────────────

router.get('/cinemas', listCinemas);
router.get('/cinemas/city/:city', getCinemasByCity);
router.get('/cinemas/:idOrSlug', getCinema);
router.get('/cinemas/:cinemaId/screens', getScreens);

// ── Showtimes (public) ────────────────────────────────────────────────────────

router.get('/showtimes', listShowtimes);
router.get('/showtimes/cities', getCitiesWithMovies);
router.get('/showtimes/:idOrSlug', getShowtime);

// ── Seat layout for a showtime (public) ───────────────────────────────────────

router.get('/showtimes/:showtimeId/seats', async (req: Request, res, next) => {
  try {
    const showtimeId = parseInt(req.params.showtimeId, 10);
    if (!Number.isFinite(showtimeId)) {
      return res.status(400).json({ success: false, message: 'Invalid showtime ID' });
    }
    const layout = await movieBookingService.getSeatLayout(showtimeId);
    return res.json({ success: true, data: layout });
  } catch (err) {
    return next(err);
  }
});

// ── Public price preview ─────────────────────────────────────────────────────

router.post('/showtimes/:showtimeId/calculate-prices', calculatePrices);

// ── Movie search (iOS discovery) ────────────────────────────────────────────────

router.get('/movies/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q || q.length < 2) {
      res.json({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 } });
      return;
    }
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const result = await movieBookingService.searchMovies(q, page, pageSize);
    res.json({ success: true, data: { items: result.items, total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages } });
  } catch (err) {
    next(err);
  }
});

// ── Authenticated booking routes ──────────────────────────────────────────────

router.use(authMiddleware);

// ── Booking (auth required) ───────────────────────────────────────────────────

router.post('/bookings', bookingRateLimiter, createBooking);
router.post('/bookings/confirm', bookingRateLimiter, confirmBooking);

router.post('/hold-seats', bookingRateLimiter, holdSeats);
router.post('/hold-seats/:holdKey/release', releaseSeats);
router.get('/hold-seats/:holdKey/status', checkHold);

router.get('/bookings/my', listMyBookings);
router.get('/bookings/:referenceOrId', getBooking);
router.post('/bookings/:referenceOrId/cancel', cancelBooking);
router.get('/bookings/:referenceOrId/tickets', getMyTickets);

router.get('/tickets/:ticketUuid/verify', verifyTicket);
router.get('/tickets/:ticketUuid/details', verifyTicket);

export { router as movieRoutes };