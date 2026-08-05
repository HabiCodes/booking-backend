import { Request, Response, NextFunction } from 'express';
import { eventService } from '../services/eventService';

export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const event = await eventService.getActiveEvent();
    if (!event) {
      return res.json({ success: true, data: [] });
    }
    const stats = await eventService.getBookingStats(event.id);
    res.json({
      success: true,
      data: [{ ...event, bookedCount: stats.bookedCount, remaining: stats.remaining }],
    });
  } catch (err) {
    next(err);
  }
}

export async function getEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const eventId = parseInt(req.params.id, 10);
    const event = await eventService.getEventById(eventId);
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    const stats = await eventService.getBookingStats(eventId);
    res.json({ success: true, data: { ...event, ...stats } });
  } catch (err) {
    next(err);
  }
}

export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const eventId = parseInt(req.params.id, 10);
    const stats = await eventService.getBookingStats(eventId);
    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
}
