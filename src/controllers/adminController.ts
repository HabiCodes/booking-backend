import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { getPool } from '../db/pool';
import { adminService } from '../services/adminService';
import { AppError } from '../middleware/errorHandler';

export async function adminLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new AppError('Email and password required', 400);
    const result = await adminService.login(email, password);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function adminStats(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { rows: bRows } = await getPool().query(
      'SELECT COUNT(*) as total_bookings, COALESCE(SUM(ticket_count), 0) as total_tickets FROM bookings'
    );
    const { rows: uRows } = await getPool().query(
      'SELECT COUNT(*) as total_users FROM users'
    );
    const { rows: cRows } = await getPool().query(
      'SELECT COUNT(*) as total_checked_in FROM tickets WHERE checked_in = true'
    );
    const { rows: eRows } = await getPool().query(
      'SELECT id, title, capacity FROM events ORDER BY id ASC LIMIT 1'
    );
    const { rows: tRows } = await getPool().query(
      'SELECT COUNT(*) as total FROM tickets'
    );

    const bookingStats = (bRows as Array<{ total_bookings: number; total_tickets: number }>)[0] ?? { total_bookings: 0, total_tickets: 0 };
    const userStats = (uRows as Array<{ total_users: number }>)[0] ?? { total_users: 0 };
    const checkinStats = (cRows as Array<{ total_checked_in: number }>)[0] ?? { total_checked_in: 0 };
    const event = (eRows as Array<{ id: number; title: string; capacity: number }>)[0] ?? { id: 0, title: '', capacity: 0 };
    const ticketStats = (tRows as Array<{ total: number }>)[0] ?? { total: 0 };

    const totalTickets = Number(ticketStats.total);
    const totalCheckedIn = Number(checkinStats.total_checked_in);

    res.json({
      success: true,
      data: {
        totalUsers: Number(userStats.total_users),
        totalBookings: Number(bookingStats.total_bookings),
        totalTickets,
        totalCheckedIn,
        remainingCheckIns: totalTickets - totalCheckedIn,
        event: {
          id: event.id,
          title: event.title,
          capacity: event.capacity,
          bookedCount: Number(bookingStats.total_tickets),
          remaining: event.capacity - Number(bookingStats.total_tickets),
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function adminBookings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = parseInt((req.query.offset as string) || '0', 10);

    const { rows } = await getPool().query(
      `SELECT b.id, b.ticket_count, b.created_at, u.email as user_email, e.title as event_title
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       INNER JOIN events e ON b.event_id = e.id
       ORDER BY b.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

export async function adminRecentTickets(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
    const { rows } = await getPool().query(
      `SELECT t.ticket_uuid, t.attendee_name, t.checked_in, t.checked_in_at, t.created_at,
              b.id as booking_id
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}
