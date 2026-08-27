import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { turfScanService } from '../services/turfScanService';
import { AppError } from '../middleware/errorHandler';

export async function verifyTurfTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const { ticket_uuid } = req.body;
    if (!ticket_uuid) throw new AppError('ticket_uuid required', 400);
    const result = await turfScanService.verify(ticket_uuid, req.admin.organizationId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function markTurfTicket(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const { ticket_uuid } = req.body;
    if (!ticket_uuid) throw new AppError('ticket_uuid required', 400);
    const result = await turfScanService.markCheckedIn(ticket_uuid, req.admin.id, req.admin.organizationId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
