/**
 * Turf booking controller — customer-facing booking operations.
 */

import { Request, Response, NextFunction } from 'express';
import { turfBookingService } from '../../services/turfBookingService';
import { turfBookingRepository } from '../../repositories/turfBookingRepository';
import { AppError } from '../../middleware/errorHandler';

export async function createBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    if (!userId) throw new AppError('Unauthorized', 401);
    const result = await turfBookingService.createBooking(userId, req.body, { actorId: userId, actorType: 'customer' });
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getMyBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    const result = await turfBookingRepository.findByUser(userId, req.query as any);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    const booking = await turfBookingRepository.findDetail(Number(req.params.id));
    if (!booking) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: booking });
  } catch (err) { next(err); }
}

export async function cancelBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    await turfBookingService.cancelBooking(Number(req.params.id), userId, req.body.reason ?? null, { actorId: userId, actorType: 'customer' });
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) { next(err); }
}

export async function checkInBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    const result = await turfBookingService.checkIn(Number(req.params.id), { actorId: userId, actorType: 'customer' });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function createReview(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?.id;
    const { rating, review } = req.body;
    const bookingId = Number(req.params.bookingId);
    const booking = await turfBookingRepository.findById(bookingId);
    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.user_id !== userId) throw new AppError('Not your booking', 403);
    if (booking.status !== 'confirmed' && booking.status !== 'completed' && booking.status !== 'checked_in') {
      throw new AppError('Can only review after booking', 400);
    }
    const result = await turfBookingService.createReview(userId, booking.venue_id, bookingId, rating, review);
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}
