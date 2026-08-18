import { Router } from 'express';
import {
  listAdminMovies, createMovie, updateMovie, deleteMovie,
  publishMovie, archiveMovie,
  listAdminCinemas, createCinema, updateCinema, deleteCinema, toggleCinema,
  createScreen, updateScreen, deleteScreen,
  listAdminShowtimes, createShowtime, updateShowtime, deleteShowtime,
  getShowtimesForCinema, getShowtimesForMovie, getShowtimeSummary,
  listPriceCaps, createPriceCap, updatePriceCap, deletePriceCap,
} from '../controllers/movieAdminController';
import { adminAuthMiddleware, AdminRequest } from '../middleware/adminAuth';
import { requirePermission } from '../middleware/permissions';
import { auditMiddleware } from '../middleware/audit';

const router = Router();
export const adminMovieRouter = Router();

adminMovieRouter.use(adminAuthMiddleware);

// ── Movies (admin) ────────────────────────────────────────────────────────────

adminMovieRouter.get('/movies', requirePermission('movies:read'), listAdminMovies);
adminMovieRouter.post('/movies', requirePermission('movies:write'), auditMiddleware('movie.create'), createMovie);
adminMovieRouter.put('/movies/:id', requirePermission('movies:write'), auditMiddleware('movie.update'), updateMovie);
adminMovieRouter.patch('/movies/:id', requirePermission('movies:write'), auditMiddleware('movie.update'), updateMovie);
adminMovieRouter.delete('/movies/:id', requirePermission('movies:delete'), auditMiddleware('movie.delete'), deleteMovie);
adminMovieRouter.post('/movies/:id/publish', requirePermission('movies:publish'), auditMiddleware('movie.publish'), publishMovie);
adminMovieRouter.post('/movies/:id/archive', requirePermission('movies:publish'), auditMiddleware('movie.archive'), archiveMovie);

// ── Cinemas (admin) ───────────────────────────────────────────────────────────

adminMovieRouter.get('/cinemas', requirePermission('movies:read'), listAdminCinemas);
adminMovieRouter.post('/cinemas', requirePermission('movies:write'), auditMiddleware('cinema.create'), createCinema);
adminMovieRouter.put('/cinemas/:id', requirePermission('movies:write'), auditMiddleware('cinema.update'), updateCinema);
adminMovieRouter.patch('/cinemas/:id', requirePermission('movies:write'), auditMiddleware('cinema.update'), updateCinema);
adminMovieRouter.delete('/cinemas/:id', requirePermission('movies:delete'), auditMiddleware('cinema.delete'), deleteCinema);
adminMovieRouter.post('/cinemas/:id/toggle', requirePermission('movies:write'), auditMiddleware('cinema.toggle'), toggleCinema);

// ── Screens (admin) ───────────────────────────────────────────────────────────

adminMovieRouter.post('/cinemas/:cinemaId/screens', requirePermission('movies:write'), auditMiddleware('screen.create'), createScreen);
adminMovieRouter.put('/screens/:screenId', requirePermission('movies:write'), auditMiddleware('screen.update'), updateScreen);
adminMovieRouter.patch('/screens/:screenId', requirePermission('movies:write'), auditMiddleware('screen.update'), updateScreen);
adminMovieRouter.delete('/screens/:screenId', requirePermission('movies:delete'), auditMiddleware('screen.delete'), deleteScreen);

// ── Showtimes (admin) ─────────────────────────────────────────────────────────

adminMovieRouter.get('/showtimes', requirePermission('movies:read'), listAdminShowtimes);
adminMovieRouter.post('/showtimes', requirePermission('movies:write'), auditMiddleware('showtime.create'), createShowtime);
adminMovieRouter.put('/showtimes/:id', requirePermission('movies:write'), auditMiddleware('showtime.update'), updateShowtime);
adminMovieRouter.patch('/showtimes/:id', requirePermission('movies:write'), auditMiddleware('showtime.update'), updateShowtime);
adminMovieRouter.delete('/showtimes/:id', requirePermission('movies:delete'), auditMiddleware('showtime.delete'), deleteShowtime);
adminMovieRouter.get('/cinemas/:cinemaId/showtimes', requirePermission('movies:read'), getShowtimesForCinema);
adminMovieRouter.get('/movies/:movieId/showtimes', requirePermission('movies:read'), getShowtimesForMovie);
adminMovieRouter.get('/showtimes/stats', requirePermission('movies:read'), getShowtimeSummary);

// ── Price Caps (admin) ────────────────────────────────────────────────────────

adminMovieRouter.get('/price-caps', requirePermission('movies:read'), listPriceCaps);
adminMovieRouter.post('/price-caps', requirePermission('movies:write'), auditMiddleware('price_cap.create'), createPriceCap);
adminMovieRouter.put('/price-caps/:id', requirePermission('movies:write'), auditMiddleware('price_cap.update'), updatePriceCap);
adminMovieRouter.patch('/price-caps/:id', requirePermission('movies:write'), auditMiddleware('price_cap.update'), updatePriceCap);
adminMovieRouter.delete('/price-caps/:id', requirePermission('movies:delete'), auditMiddleware('price_cap.delete'), deletePriceCap);

export default router;