"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminLogin = adminLogin;
exports.adminStats = adminStats;
exports.adminBookings = adminBookings;
exports.adminRecentTickets = adminRecentTickets;
exports.adminAuditLogs = adminAuditLogs;
exports.adminListAdmins = adminListAdmins;
exports.adminMe = adminMe;
exports.adminUsers = adminUsers;
exports.adminCancelBooking = adminCancelBooking;
const pool_1 = require("../db/pool");
const adminService_1 = require("../services/adminService");
const errorHandler_1 = require("../middleware/errorHandler");
const auditLogRepository_1 = require("../repositories/auditLogRepository");
// ═══════════════════════════════════════════════════════════════════════════════
// Public-facing admin login (no auth middleware)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminLogin(req, res, next) {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            throw new errorHandler_1.AppError('Email and password required', 400);
        const result = await adminService_1.adminService.login(email, password);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard stats (authenticated)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminStats(req, res, next) {
    try {
        const { rows: bRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total_bookings,
              COALESCE(SUM(ticket_count), 0) as total_tickets,
              COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
              COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
       FROM bookings`);
        const { rows: uRows } = await (0, pool_1.getPool)().query('SELECT COUNT(*) as total_users FROM users');
        const { rows: cRows } = await (0, pool_1.getPool)().query('SELECT COUNT(*) as total_checked_in FROM tickets WHERE checked_in = true');
        const { rows: eRows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total_events FROM events WHERE status = 'published'`);
        const { rows: dRows } = await (0, pool_1.getPool)().query(`SELECT e.id, e.title, e.capacity,
              COALESCE(SUM(b.ticket_count), 0) as booked,
              COUNT(t.id) as tickets_checked_in
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       LEFT JOIN tickets t ON t.booking_id = b.id AND t.checked_in = true
       GROUP BY e.id, e.title, e.capacity
       ORDER BY e.id DESC`);
        const bookingStats = bRows[0] ?? { total_bookings: 0, total_tickets: 0, confirmed: 0, cancelled: 0 };
        const userStats = uRows[0] ?? { total_users: 0 };
        const checkinStats = cRows[0] ?? { total_checked_in: 0 };
        const eventStats = eRows[0] ?? { total_events: 0 };
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
                    breakdown: dRows.map((ev) => ({
                        id: ev.id,
                        title: ev.title,
                        capacity: ev.capacity,
                        booked: typeof ev.booked === 'string' ? parseInt(ev.booked, 10) : Number(ev.booked),
                        checkedIn: typeof ev.tickets_checked_in === 'string' ? parseInt(ev.tickets_checked_in, 10) : Number(ev.tickets_checked_in),
                    })),
                },
            },
        });
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Bookings list (paginated, with user + event join)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminBookings(req, res, next) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 200);
        const offset = (page - 1) * pageSize;
        const status = req.query.status;
        let countQuery = 'SELECT COUNT(*) FROM bookings b';
        let dataQuery = `
      SELECT b.id, b.ticket_count, b.status, b.created_at,
             u.email as user_email, u.username as user_username,
             e.title as event_title, e.event_date, e.venue as event_venue
      FROM bookings b
      INNER JOIN users u ON b.user_id = u.id
      INNER JOIN events e ON b.event_id = e.id`;
        const params = [];
        if (status) {
            countQuery += ' WHERE b.status = $1';
            dataQuery += ' WHERE b.status = $1';
            params.push(status);
        }
        const { rows: countRows } = await (0, pool_1.getPool)().query(`${countQuery} ${params.length > 0 ? 'WHERE ' + params.map((_, i) => `b.status = $${i + 1}`).join(' AND ') : ''}`, status ? [status] : []);
        // count above is wrong; let me use a proper count query:
        const totalRes = await (0, pool_1.getPool)().query(status
            ? 'SELECT COUNT(*) as total FROM bookings WHERE status = $1'
            : 'SELECT COUNT(*) as total FROM bookings', status ? [status] : []);
        const total = Number(totalRes.rows[0]?.total ?? 0);
        const { rows } = await (0, pool_1.getPool)().query(`${dataQuery} ORDER BY b.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...(status ? [status] : []), pageSize, offset]);
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
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Recent tickets
// ═══════════════════════════════════════════════════════════════════════════════
async function adminRecentTickets(req, res, next) {
    try {
        const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
        const { rows } = await (0, pool_1.getPool)().query(`SELECT t.ticket_uuid, t.attendee_name, t.attendee_phone,
              t.checked_in, t.checked_in_at, t.checked_in_by, t.created_at,
              b.id as booking_id, e.title as event_title
       FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       INNER JOIN events e ON b.event_id = e.id
       ORDER BY t.created_at DESC
       LIMIT $1`, [limit]);
        res.json({ success: true, data: rows });
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Audit log viewer
// ═══════════════════════════════════════════════════════════════════════════════
async function adminAuditLogs(req, res, next) {
    try {
        const query = {
            adminId: req.query.admin_id ? parseInt(req.query.admin_id, 10) : undefined,
            action: req.query.action,
            entityType: req.query.entity_type,
            entityId: req.query.entity_id ? parseInt(req.query.entity_id, 10) : undefined,
            limit: Math.min(parseInt(req.query.limit || '50', 10), 200),
            offset: parseInt(req.query.offset || '0', 10),
        };
        const result = await auditLogRepository_1.auditLogRepository.findAll(query);
        res.json({ success: true, data: result.items, pagination: { total: result.total, offset: query.offset, limit: query.limit } });
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Admin listing (self + team management)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminListAdmins(req, res, next) {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
        const offset = parseInt(req.query.offset || '0', 10);
        const admins = await adminService_1.adminService.listAll(limit, offset);
        const { rows: countRows } = await (0, pool_1.getPool)().query('SELECT COUNT(*) as total FROM admins');
        const total = Number(countRows[0]?.total ?? 0);
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
    }
    catch (err) {
        next(err);
    }
}
async function adminMe(req, res, next) {
    try {
        if (!req.admin)
            return next(new errorHandler_1.AppError('Unauthorized', 401));
        const row = await adminService_1.adminService.findById(req.admin.id);
        if (!row)
            return next(new errorHandler_1.AppError('Admin not found', 404));
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
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Users list (admin view of all users)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminUsers(req, res, next) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 200);
        const offset = (page - 1) * pageSize;
        const search = req.query.search;
        let whereClause = '';
        const params = [];
        let idx = 1;
        if (search) {
            whereClause = `WHERE email ILIKE $${idx++} OR username ILIKE $${idx++}`;
            params.push(`%${search}%`, `%${search}%`);
        }
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, username, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`, [...params, pageSize, offset]);
        const { rows: countRows } = await (0, pool_1.getPool)().query(search ? 'SELECT COUNT(*) as total FROM users WHERE email ILIKE $1 OR username ILIKE $2' : 'SELECT COUNT(*) as total FROM users', search ? [`%${search}%`, `%${search}%`] : []);
        const total = Number(countRows[0]?.total ?? 0);
        res.json({
            success: true,
            data: rows.map((r) => ({
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
    }
    catch (err) {
        next(err);
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// Booking cancellation (admin override)
// ═══════════════════════════════════════════════════════════════════════════════
async function adminCancelBooking(req, res, next) {
    try {
        if (!req.admin)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const bookingId = parseInt(req.params.id, 10);
        if (!Number.isFinite(bookingId))
            throw new errorHandler_1.AppError('Invalid booking ID', 400);
        const reason = req.body?.reason ?? 'Cancelled by admin';
        const { bookingRepository } = await Promise.resolve().then(() => __importStar(require('../repositories/bookingRepository')));
        const result = await bookingRepository.cancelBooking(bookingId, 0, reason);
        if (!result.cancelled) {
            return next(new errorHandler_1.AppError('Booking not found or already cancelled', 404));
        }
        res.json({ success: true, message: 'Booking cancelled', data: result });
    }
    catch (err) {
        next(err);
    }
}
