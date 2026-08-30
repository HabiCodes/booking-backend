import { Response, NextFunction } from 'express';
import { movieBookingService } from '../services/movieBookingService';
import { movieTicketService } from '../services/movieTicketService';
import { getRedis } from '../db/redis';
import type { AuthRequest } from '../middleware/auth';

// ── Public booking endpoints (require user auth) ──────────────────────────────

export async function calculatePrices(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const showtimeId = parseInt(req.params.showtimeId, 10);
    const seatIds: number[] = Array.isArray(req.body?.seatIds)
      ? (req.body.seatIds as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    if (!Number.isFinite(showtimeId) || seatIds.length === 0) {
      return res.status(400).json({ success: false, message: 'showtimeId and seatIds[] are required' });
    }
    const prices = await movieBookingService.calculatePrices(showtimeId, seatIds);
    return res.json({ success: true, data: prices });
  } catch (err) {
    return next(err);
  }
}

export async function holdSeats(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const showtimeId = parseInt(req.body?.showtimeId, 10);
    const seatIds: number[] = Array.isArray(req.body?.seatIds)
      ? (req.body.seatIds as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];
    if (!Number.isFinite(showtimeId) || seatIds.length === 0) {
      return res.status(400).json({ success: false, message: 'showtimeId and seatIds[] are required' });
    }
    if (seatIds.length > 10) {
      return res.status(400).json({ success: false, message: 'Cannot hold more than 10 seats at once' });
    }

    const result = await movieBookingService.holdSeats(userId, showtimeId, seatIds);
    if (!result.success) {
      return res.status(409).json({
        success: false,
        message: 'Some seats are no longer available',
        data: result,
      });
    }
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

export async function releaseSeats(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const holdKey = req.params.holdKey || req.body?.holdKey;
    if (!holdKey) return res.status(400).json({ success: false, message: 'holdKey required' });

    await movieBookingService.releaseSeats(userId, holdKey);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

export async function createBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const holdKey = req.body?.holdKey as string | undefined;
    const idempotencyKey = (req.body?.idempotencyKey as string | undefined) || (req.headers['idempotency-key'] as string | undefined);
    const customerEmail = req.body?.customerEmail as string | undefined;
    const customerPhone = req.body?.customerPhone as string | undefined;
    const customerName = req.body?.customerName as string | undefined;
    const notes = req.body?.notes as string | undefined;

    if (!holdKey) return res.status(400).json({ success: false, message: 'holdKey required' });

    const result = await movieBookingService.createBooking({
      userId,
      holdKey,
      idempotencyKey,
      customerEmail,
      customerPhone,
      customerName,
      notes,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

export async function confirmBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const bookingReference = req.body?.bookingReference;
    if (!bookingReference) return res.status(400).json({ success: false, message: 'bookingReference required' });

    const result = await movieBookingService.confirmBookingByReference({
      userId,
      bookingReference,
      paymentOrderId: req.body?.paymentOrderId as string | undefined,
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

export async function getBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const reference = req.params.reference || req.params.id;
    const booking = await movieBookingService.getBookingForUser(userId, reference);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    return res.json({ success: true, data: booking });
  } catch (err) {
    return next(err);
  }
}

export async function listMyBookings(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const status = req.query.status as string | undefined;
    const upcoming = req.query.upcoming === 'true';
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = Math.min(req.query.pageSize ? Number(req.query.pageSize) : 20, 50);

    const result = await movieBookingService.listMyBookings(userId, { status, upcoming, page, pageSize });
    return res.json({ success: true, data: result.items, pagination: { page: result.page, pageSize: result.pageSize, total: result.total, totalPages: result.totalPages } });
  } catch (err) {
    return next(err);
  }
}

export async function cancelBooking(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const reference = req.params.reference || req.params.id;
    const result = await movieBookingService.cancelBookingByReference(userId, reference, req.body?.reason as string | null);
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

// ── Tickets (require user auth) ──────────────────────────────────────────────

export async function getMyTickets(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const reference = req.params.reference || req.params.id;
    const tickets = await movieTicketService.getTicketsForUser(userId, reference);
    return res.json({ success: true, data: tickets });
  } catch (err) {
    return next(err);
  }
}

export async function verifyTicket(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ticketUuid = req.params.ticketUuid;
    if (!ticketUuid) return res.status(400).json({ success: false, message: 'ticketUuid required' });

    const result = await movieTicketService.verifyTicket(ticketUuid);
    return res.json({ success: true, data: result });
  } catch (err) {
    return next(err);
  }
}

// ── Health: hold key existence (for client polling) ──────────────────────────

export async function checkHold(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const holdKey = req.params.holdKey;
    if (!holdKey) return res.status(400).json({ success: false, message: 'holdKey required' });

    const ttl = await getRedis().ttl(holdKey);
    const exists = ttl > 0;
    const seatIds: number[] = exists
      ? (await getRedis().smembers(holdKey)).map((s) => Number(s)).filter((n) => Number.isFinite(n))
      : [];

    return res.json({
      success: true,
      data: {
        active: exists,
        ttlSeconds: exists ? ttl : 0,
        seatIds,
        expiresAt: exists ? new Date(Date.now() + ttl * 1000).toISOString() : null,
      },
    });
  } catch (err) {
    return next(err);
  }
}