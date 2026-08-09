import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { getPool } from '../db/pool';
import { adminService } from '../services/adminService';
import { AppError } from '../middleware/errorHandler';
import { auditLogRepository } from '../repositories/auditLogRepository';

// ═══════════════════════════════════════════════════════════════════════════════
// Public-facing admin login (no auth middleware)
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard stats (authenticated)
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminStats(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const { rows: bRows } = await getPool().query(
      `SELECT COUNT(*) as total_bookings,
              COALESCE(SUM(ticket_count), 0) as total_tickets,
              COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
              COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
       FROM bookings`
    );
    const { rows: uRows } = await getPool().query(
      'SELECT COUNT(*) as total_users FROM users'
    );
    const { rows: cRows } = await getPool().query(
      'SELECT COUNT(*) as total_checked_in FROM tickets WHERE checked_in = true'
    );
    const { rows: eRows } = await getPool().query(
      `SELECT COUNT(*) as total_events FROM events WHERE status = 'published'`
    );
    const { rows: dRows } = await getPool().query(
      `SELECT e.id, e.title, e.capacity,
              COALESCE(SUM(b.ticket_count), 0) as booked,
              COUNT(t.id) as tickets_checked_in
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       LEFT JOIN tickets t ON t.booking_id = b.id AND t.checked_in = true
       GROUP BY e.id, e.title, e.capacity
       ORDER BY e.id DESC`
    );

    const bookingStats = (bRows as Array<{ total_bookings: number; total_tickets: number; confirmed: number; cancelled: number }>)[0] ?? { total_bookings: 0, total_tickets: 0, confirmed: 0, cancelled: 0 };
    const userStats = (uRows as Array<{ total_users: number }>)[0] ?? { total_users: 0 };
    const checkinStats = (cRows as Array<{ total_checked_in: number }>)[0] ?? { total_checked_in: 0 };
    const eventStats = (eRows as Array<{ total_events: number }>)[0] ?? { total_events: 0 };

    const totalTickets = Number(bookingStats.total_tickets);
    const totalCheckedIn = Number(checkinStats.total_checked_in);

    res.json({
      success: true,
      data: {
        users: Number(userStats.total_users),
        bookings: {
          total: Number(bookingStats.total_bookings),
          confirmed: Number(bookingStats.confirmed),
          cancelled: Number(bookingStats.cancelled),
          totalTickets,
        },
        checkIns: {
          total: totalCheckedIn,
          remaining: totalTickets - totalCheckedIn,
          rate: totalTickets > 0 ? Number((totalCheckedIn / totalTickets * 100).toFixed(1)) : 0,
        },
        events: {
          total: Number(eventStats.total_events),
          breakdown: (dRows as Array<{
            id: number;
            title: string;
            capacity: number;
            booked: number | string;
            tickets_checked_in: number | string;
          }>).map((ev) => ({
            id: ev.id,
            title: ev.title,
            capacity: ev.capacity,
            booked: typeof ev.booked === 'string' ? parseInt(ev.booked, 10) : Number(ev.booked),
            checkedIn: typeof ev.tickets_checked_in === 'string' ? parseInt(ev.tickets_checked_in, 10) : Number(ev.tickets_checked_in),
          })),
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bookings list (paginated, with user + event join)
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminBookings(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 200);
    const offset = (page - 1) * pageSize;
    const status = req.query.status as string | undefined;

    const whereClause = status ? 'WHERE b.status = $1' : '';
    const params: unknown[] = status ? [status] : [];

    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM bookings b ${whereClause}`,
      params
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    const { rows } = await getPool().query(
      `SELECT b.id, b.ticket_count, b.status, b.created_at,
              u.email as user_email, u.username as user_username,
              e.title as event_title, e.event_date, e.venue as event_venue
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       INNER JOIN events e ON b.event_id = e.id
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    res.json({
      success: true,
      data: rows,
      pagination: {
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Recent tickets
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminRecentTickets(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 100);
    const { rows } = await getPool().query(
      `SELECT t.ticket_uuid, t.attendee_name, t.attendee_phone,
              t.checked_in, t.checked_in_at, t.checked_in_by, t.created_at,
              b.id as booking_id, e.title as event_title
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audit log viewer
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminAuditLogs(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const query = {
      adminId: req.query.admin_id ? parseInt(req.query.admin_id as string, 10) : undefined,
      action: req.query.action as string | undefined,
      entityType: req.query.entity_type as string | undefined,
      entityId: req.query.entity_id ? parseInt(req.query.entity_id as string, 10) : undefined,
      limit: Math.min(parseInt((req.query.limit as string) || '50', 10), 200),
      offset: parseInt((req.query.offset as string) || '0', 10),
    };
    const result = await auditLogRepository.findAll(query);
    res.json({ success: true, data: result.items, pagination: { total: result.total, offset: query.offset, limit: query.limit } });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Admin listing (self + team management)
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminListAdmins(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    const admins = await adminService.listAll(limit, offset);

    const { rows: countRows } = await getPool().query('SELECT COUNT(*) as total FROM admins');
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    res.json({
      success: true,
      data: admins.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        role: a.role,
        is_active: a.is_active,
        last_login_at: a.last_login_at,
        created_at: a.created_at,
      })),
      pagination: { total, offset, limit, page: Math.floor(offset / limit) + 1 },
    });
  } catch (err) {
    next(err);
  }
}

export async function adminMe(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) return next(new AppError('Unauthorized', 401));
    const row = await adminService.findById(req.admin.id);
    if (!row) return next(new AppError('Admin not found', 404));
    res.json({
      success: true,
      data: {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        is_active: row.is_active,
        last_login_at: row.last_login_at,
        permissions: row.permissions,
        created_at: row.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Users list (admin view of all users)
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminUsers(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(parseInt((req.query.pageSize as string) || '25', 10), 200);
    const offset = (page - 1) * pageSize;
    const search = req.query.search as string | undefined;

    let whereClause = '';
    const params: unknown[] = [];
    let idx = 1;

    if (search) {
      whereClause = `WHERE email ILIKE $${idx++} OR username ILIKE $${idx++}`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const { rows } = await getPool().query(
      `SELECT id, email, username, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );

    const { rows: countRows } = await getPool().query(
      search ? 'SELECT COUNT(*) as total FROM users WHERE email ILIKE $1 OR username ILIKE $2' : 'SELECT COUNT(*) as total FROM users',
      search ? [`%${search}%`, `%${search}%`] : []
    );
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    res.json({
      success: true,
      data: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        email: r.email,
        username: r.username,
        is_verified: r.is_verified,
        is_active: r.is_active,
        last_login_at: r.last_login_at,
        created_at: r.created_at,
      })),
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
    });
  } catch (err) {
    next(err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Booking cancellation (admin override)
// ═══════════════════════════════════════════════════════════════════════════════

export async function adminCancelBooking(req: AdminRequest, res: Response, next: NextFunction) {
  try {
    if (!req.admin) throw new AppError('Unauthorized', 401);
    const bookingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(bookingId)) throw new AppError('Invalid booking ID', 400);
    const reason = (req.body?.reason as string | undefined) ?? 'Cancelled by admin';

    const { bookingRepository } = await import('../repositories/bookingRepository');
    const result = await bookingRepository.cancelBooking(bookingId, 0, reason);

    if (!result.cancelled) {
      return next(new AppError('Booking not found or already cancelled', 404));
    }

    res.json({ success: true, message: 'Booking cancelled', data: result });
  } catch (err) {
    next(err);
  }
}
