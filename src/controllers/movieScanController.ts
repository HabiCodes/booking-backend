import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { movieScanService } from '../services/movieScanService';
import { AppError } from '../middleware/errorHandler';

export async function verifyMovieTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { ticket_uuid } = req.body;
    if (!ticket_uuid) throw new AppError('ticket_uuid required', 400);
    const result = await movieScanService.verify(ticket_uuid);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function markMovieTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const { ticket_uuid } = req.body;
    if (!ticket_uuid) throw new AppError('ticket_uuid required', 400);
    const result = await movieScanService.markCheckedIn(ticket_uuid, req.admin.id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
