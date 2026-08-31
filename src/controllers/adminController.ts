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
    const orgId = req.admin?.organizationId ?? null;

    // Booking counts scoped by event organization_id (events.organization_id references orgs)
    const bookingQuery = orgId !== null
      ? `SELECT COUNT(*) as total_bookings,
              COALESCE(SUM(b.ticket_count), 0) as total_tickets,
              COUNT(CASE WHEN b.status = 'confirmed' THEN 1 END) as confirmed,
              COUNT(CASE WHEN b.status = 'cancelled' THEN 1 END) as cancelled
       FROM bookings b INNER JOIN events e ON b.event_id = e.id
       WHERE e.organization_id = $1`
      : `SELECT COUNT(*) as total_bookings,
              COALESCE(SUM(ticket_count), 0) as total_tickets,
              COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
              COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
       FROM bookings`;
    const { rows: bRows } = await getPool().query(bookingQuery, orgId !== null ? [String(orgId)] : []);

    // Users: scope to users who have bookings for events in this org
    const usersQuery = orgId !== null
      ? `SELECT COUNT(DISTINCT u.id) as total_users FROM users u
         INNER JOIN bookings b ON b.user_id = u.id
         INNER JOIN events e ON b.event_id = e.id
         WHERE e.organization_id = $1`
      : 'SELECT COUNT(*) as total_users FROM users';
    const { rows: uRows } = await getPool().query(usersQuery, orgId !== null ? [String(orgId)] : []);

    // Check-ins: scope to tickets from events in this org
    const checkinsQuery = orgId !== null
      ? `SELECT COUNT(*) as total_checked_in FROM tickets t
         INNER JOIN bookings b ON t.booking_id = b.id
         INNER JOIN events e ON b.event_id = e.id
         WHERE t.checked_in = true AND e.organization_id = $1`
      : 'SELECT COUNT(*) as total_checked_in FROM tickets WHERE checked_in = true';
    const { rows: cRows } = await getPool().query(checkinsQuery, orgId !== null ? [String(orgId)] : []);

    // Published events count (scoped)
    const eventsQuery = orgId !== null
      ? `SELECT COUNT(*) as total_events FROM events WHERE status = 'published' AND organization_id = $1`
      : `SELECT COUNT(*) as total_events FROM events WHERE status = 'published'`;
    const { rows: eRows } = await getPool().query(eventsQuery, orgId !== null ? [String(orgId)] : []);

    // Event breakdown — uses scalar subqueries to avoid Cartesian product
    // between bookings and tickets (LEFT JOIN would inflate SUM(b.ticket_count)).
    const breakdownQuery = orgId !== null
      ? `SELECT e.id, e.title, e.capacity,
              COALESCE((
                SELECT SUM(b.ticket_count) FROM bookings b
                WHERE b.event_id = e.id AND b.deleted_at IS NULL
              ), 0) as booked,
              COALESCE((
                SELECT COUNT(*) FROM tickets t
                INNER JOIN bookings b2 ON t.booking_id = b2.id
                WHERE b2.event_id = e.id AND t.checked_in = true
              ), 0) as tickets_checked_in
       FROM events e
       WHERE e.organization_id = $1
       ORDER BY e.id DESC`
      : `SELECT e.id, e.title, e.capacity,
              COALESCE((
                SELECT SUM(b.ticket_count) FROM bookings b
                WHERE b.event_id = e.id AND b.deleted_at IS NULL
              ), 0) as booked,
              COALESCE((
                SELECT COUNT(*) FROM tickets t
                INNER JOIN bookings b2 ON t.booking_id = b2.id
                WHERE b2.event_id = e.id AND t.checked_in = true
              ), 0) as tickets_checked_in
       FROM events e
       ORDER BY e.id DESC`;
    const { rows: dRows } = await getPool().query(breakdownQuery, orgId !== null ? [String(orgId)] : []);

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
    const orgId = req.admin?.organizationId ?? null;

    // Fetch enough rows from each domain to cover any page. Since we merge
    // 3 domains and sort cross-domain, we fetch pageSize*3 from each.
    const fetchSize = pageSize * 3;

    // ── Event bookings ────────────────────────────────────────────────────────
    const eventWClauses: string[] = status ? [`b.status = $1`] : [];
    const eventParams: unknown[] = status ? [status] : [];
    if (orgId !== null) eventWClauses.push(`e.organization_id = $${eventParams.length + 1}`);
    if (orgId !== null) eventParams.push(String(orgId));
    const eventWhere = eventWClauses.length ? `WHERE ${eventWClauses.join(' AND ')}` : '';

    const { rows: eventCountRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM bookings b INNER JOIN events e ON b.event_id = e.id ${eventWhere}`,
      eventParams
    );
    const eventTotal = Number((eventCountRows as Array<{ total: number | string }>)[0]?.total ?? 0);

    const { rows: eventRows } = await getPool().query(
      `SELECT b.id, b.ticket_count, b.status, b.created_at,
              u.email as user_email, u.username as user_username,
              e.title as event_title, e.event_date, e.venue as event_venue
       FROM bookings b
       INNER JOIN users u ON b.user_id = u.id
       INNER JOIN events e ON b.event_id = e.id
       ${eventWhere}
       ORDER BY b.created_at DESC
       LIMIT $${eventParams.length + 1} OFFSET $${eventParams.length + 2}`,
      [...eventParams, fetchSize, 0]
    );

    // ── Turf bookings ────────────────────────────────────────────────────────
    const turfWClauses: string[] = ['tb.deleted_at IS NULL'];
    const turfParams: unknown[] = [];
    if (status) { turfWClauses.push(`tb.status = $${turfParams.length + 1}`); turfParams.push(status); }
    if (orgId !== null) { turfWClauses.push(`tb.organization_id = $${turfParams.length + 1}`); turfParams.push(String(orgId)); }
    const turfWhere = `WHERE ${turfWClauses.join(' AND ')}`;

    const { rows: turfCountRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM turf_bookings tb ${turfWhere}`,
      turfParams
    );
    const turfTotal = Number((turfCountRows as Array<{ count: number | string }>)[0]?.count ?? 0);

    const { rows: turfRows } = await getPool().query(
      `SELECT tb.id, tb.quantity as ticket_count, tb.status, tb.created_at,
              u.email as user_email, u.username as user_username,
              tv.name as event_title, null::text as event_date, null::text as event_venue
       FROM turf_bookings tb
       INNER JOIN users u ON tb.user_id = u.id
       INNER JOIN turf_venues tv ON tb.venue_id = tv.id
       ${turfWhere}
       ORDER BY tb.created_at DESC
       LIMIT $${turfParams.length + 1} OFFSET $${turfParams.length + 2}`,
      [...turfParams, fetchSize, 0]
    );

    // ── Movie bookings ───────────────────────────────────────────────────────
    const movieWClauses: string[] = ['mb.deleted_at IS NULL'];
    const movieParams: unknown[] = [];
    if (status) { movieWClauses.push(`mb.status = $${movieParams.length + 1}`); movieParams.push(status); }
    if (orgId !== null) { movieWClauses.push(`mb.organization_id = $${movieParams.length + 1}`); movieParams.push(String(orgId)); }
    const movieWhere = `WHERE ${movieWClauses.join(' AND ')}`;

    const { rows: movieCountRows } = await getPool().query(
      `SELECT COUNT(*) as total FROM movie_bookings mb ${movieWhere}`,
      movieParams
    );
    const movieTotal = Number((movieCountRows as Array<{ count: number | string }>)[0]?.count ?? 0);

    const { rows: movieRows } = await getPool().query(
      `SELECT mb.id, mb.seat_count as ticket_count, mb.status, mb.created_at,
              mb.customer_email as user_email, mb.customer_name as user_username,
              m.title as event_title, null::text as event_date, null::text as event_venue
       FROM movie_bookings mb
       INNER JOIN movies m ON mb.movie_id = m.id
       ${movieWhere}
       ORDER BY mb.created_at DESC
       LIMIT $${movieParams.length + 1} OFFSET $${movieParams.length + 2}`,
      [...movieParams, fetchSize, 0]
    );

    // ── Merge, sort, and paginate ────────────────────────────────────────────
    const combinedRows = [
      ...(eventRows as Array<{ id: number; ticket_count: number; status: string; created_at: string; user_email: string; user_username: string; event_title: string; event_date: string | null; event_venue: string | null }>),
      ...(turfRows as Array<{ id: number; ticket_count: number; status: string; created_at: string; user_email: string; user_username: string; event_title: string; event_date: string | null; event_venue: string | null }>),
      ...(movieRows as Array<{ id: number; ticket_count: number; status: string; created_at: string; user_email: string; user_username: string; event_title: string; event_date: string | null; event_venue: string | null }>),
    ];
    combinedRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const paginatedRows = combinedRows.slice(offset, offset + pageSize);
    const combinedTotal = eventTotal + turfTotal + movieTotal;

    res.json({
      success: true,
      data: paginatedRows,
      pagination: {
        total: combinedTotal,
        page,
        pageSize,
        totalPages: Math.ceil(combinedTotal / pageSize) || 1,
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
    const orgId = req.admin?.organizationId ?? null;

    // ── Event tickets ──────────────────────────────────────────────────────────
    const eventQuery = orgId !== null
      ? `SELECT t.ticket_uuid, t.attendee_name, t.attendee_phone,
              t.checked_in, t.checked_in_at, t.checked_in_by, t.created_at,
              b.id as booking_id, e.title as event_title
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       WHERE e.organization_id = $1
       ORDER BY t.created_at DESC
       LIMIT $2`
      : `SELECT t.ticket_uuid, t.attendee_name, t.attendee_phone,
              t.checked_in, t.checked_in_at, t.checked_in_by, t.created_at,
              b.id as booking_id, e.title as event_title
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       ORDER BY t.created_at DESC
       LIMIT $1`;
    const eventParams = orgId !== null ? [String(orgId), limit] : [limit];
    const eventRows = await getPool().query(eventQuery, eventParams);

    // ── Turf QR tickets ───────────────────────────────────────────────────────
    const turfQuery = orgId !== null
      ? `SELECT qt.token as ticket_uuid, NULL::text as attendee_name, NULL::text as attendee_phone,
              (qt.status = 'used') as checked_in, qt.used_at as checked_in_at,
              qt.used_by as checked_in_by, qt.created_at,
              qt.booking_id, tv.name as event_title
       FROM turf_qr_tickets qt
       INNER JOIN turf_bookings tb ON qt.booking_id = tb.id
       INNER JOIN turf_venues tv ON tb.venue_id = tv.id
       WHERE tb.organization_id = $1
       ORDER BY qt.created_at DESC
       LIMIT $2`
      : `SELECT qt.token as ticket_uuid, NULL::text as attendee_name, NULL::text as attendee_phone,
              (qt.status = 'used') as checked_in, qt.used_at as checked_in_at,
              qt.used_by as checked_in_by, qt.created_at,
              qt.booking_id, tv.name as event_title
       FROM turf_qr_tickets qt
       INNER JOIN turf_bookings tb ON qt.booking_id = tb.id
       INNER JOIN turf_venues tv ON tb.venue_id = tv.id
       ORDER BY qt.created_at DESC
       LIMIT $1`;
    const turfParams = orgId !== null ? [String(orgId), limit] : [limit];
    const turfRows = await getPool().query(turfQuery, turfParams);

    // Merge and sort by created_at DESC
    const combined = [
      ...(eventRows.rows as Array<{ ticket_uuid: string; attendee_name: string | null; attendee_phone: string | null; checked_in: boolean; checked_in_at: string | null; checked_in_by: number | null; created_at: string; booking_id: number; event_title: string }>),
      ...(turfRows.rows as Array<{ ticket_uuid: string; attendee_name: string | null; attendee_phone: string | null; checked_in: boolean; checked_in_at: string | null; checked_in_by: number | null; created_at: string; booking_id: number; event_title: string }>),
    ];
    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const paginated = combined.slice(0, limit * 2);

    res.json({ success: true, data: paginated });
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
      organizationId: req.admin?.organizationId ?? null,
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
    const orgId = req.admin?.organizationId ?? null;

    // For org-scoped admins: restrict to users who have bookings (event/turf/movie)
    // in their organization. Super_admin (orgId=null) sees all users.
    if (orgId !== null) {
      const whereParts: string[] = [];
      const params: unknown[] = [String(orgId), String(orgId), String(orgId)];
      let idx = 4;

      if (search) {
        whereParts.push(`(u.email ILIKE $${idx++} OR u.username ILIKE $${idx++})`);
        params.push(`%${search}%`, `%${search}%`);
      }

      const whereStr = whereParts.length > 0 ? `AND ${whereParts.join(' AND ')}` : '';

      const { rows: countRows } = await getPool().query(
        `SELECT COUNT(*) as total FROM users u
         WHERE EXISTS (
           SELECT 1 FROM bookings b
           INNER JOIN events e ON b.event_id = e.id
           WHERE b.user_id = u.id AND e.organization_id = $1 AND b.deleted_at IS NULL
           UNION ALL
           SELECT 1 FROM turf_bookings tb
           WHERE tb.user_id = u.id AND tb.organization_id = $2 AND tb.deleted_at IS NULL
           UNION ALL
           SELECT 1 FROM movie_bookings mb
           INNER JOIN movies m ON mb.movie_id = m.id
           WHERE mb.user_id = u.id AND m.organization_id = $3 AND mb.deleted_at IS NULL
         )
         ${whereStr}`,
        params
      );

      const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);

      const { rows } = await getPool().query(
        `SELECT u.id, u.email, u.username, u.is_verified, u.is_active,
                u.last_login_at, u.email_verified_at, u.created_at
         FROM users u
         WHERE EXISTS (
           SELECT 1 FROM bookings b
           INNER JOIN events e ON b.event_id = e.id
           WHERE b.user_id = u.id AND e.organization_id = $1 AND b.deleted_at IS NULL
           UNION ALL
           SELECT 1 FROM turf_bookings tb
           WHERE tb.user_id = u.id AND tb.organization_id = $2 AND tb.deleted_at IS NULL
           UNION ALL
           SELECT 1 FROM movie_bookings mb
           INNER JOIN movies m ON mb.movie_id = m.id
           WHERE mb.user_id = u.id AND m.organization_id = $3 AND mb.deleted_at IS NULL
         )
         ${whereStr}
         ORDER BY u.created_at DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
        [...params, pageSize, offset]
      );

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
      return;
    }

    // Super_admin: no org scoping
    const whereClause = search ? `WHERE email ILIKE $1 OR username ILIKE $2` : '';
    const searchParams = search ? [`%${search}%`, `%${search}%`] : [];

    const { rows } = await getPool().query(
      `SELECT id, email, username, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${searchParams.length + 1} OFFSET $${searchParams.length + 2}`,
      [...searchParams, pageSize, offset]
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
    const result = await bookingRepository.cancelBooking(bookingId, undefined, reason);

    if (!result.cancelled) {
      return next(new AppError('Booking not found or already cancelled', 404));
    }

    res.json({ success: true, message: 'Booking cancelled', data: result });
  } catch (err) {
    next(err);
  }
}
