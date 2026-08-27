/**
 * Turf Manager Routes — offline booking, QR validation, attendance, reports.
 *
 * Uses the organizer auth middleware (organizer JWT) + organization scoping.
 */

import { Router } from 'express';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';
import { AppError } from '../middleware/errorHandler';
import { turfBookingService } from '../services/turfBookingService';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfAvailabilityRepository } from '../repositories/turfAvailabilityRepository';
import { turfQRRepository } from '../repositories/turfQRRepository';
import { turfResourceRepository } from '../repositories/turfResourceRepository';
import { turfVenueRepository } from '../repositories/turfVenueRepository';
import { UniversalTicketService } from '../services/universalTicketService';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';

const router = Router();

// All manager routes require organizer authentication
router.use(organizerAuthMiddleware);

// ── Offline Booking (Walk-in) ────────────────────────────────────────────────

router.post('/organizations/:organizationId/offline-booking',
  async (req, res, next) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { availabilityUnitId, customerName, customerPhone, quantity = 1 } = req.body;

      if (!availabilityUnitId) throw new AppError('availabilityUnitId is required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      // Verify slot is available
      const unit = await turfAvailabilityRepository.findById(Number(availabilityUnitId));
      if (!unit || unit.status !== 'available') {
        throw new AppError('Slot not available', 409);
      }

      // Get resource and venue
      const resource = await turfResourceRepository.findById(unit.resource_id);
      if (!resource) throw new AppError('Resource not found', 404);

      const venue = await turfVenueRepository.findById(resource.venue_id);
      if (!venue || venue.organization_id !== orgId) throw new AppError('Venue not in your organization', 403);

      // Find or create customer user
      let customerRows = await getPool().query('SELECT * FROM users WHERE phone = $1', [customerPhone]);
      let customerId: number;

      if (customerRows.rows.length) {
        customerId = customerRows.rows[0].id;
      } else {
        const result = await getPool().query(
          'INSERT INTO users (phone, username, role) VALUES ($1, $2, $3) RETURNING id',
          [customerPhone, customerName || customerPhone, 'customer']
        );
        customerId = result.rows[0].id;
      }

      // Create offline booking
      const booking = await turfBookingService.createBooking(customerId, {
        availability_unit_id: Number(availabilityUnitId),
        quantity,
        booking_type: 'offline',
      }, { actorId: userId, actorType: 'manager' });

      // Auto-confirm offline bookings
      const confirmed = await turfBookingService.confirmBooking(booking.booking.id, {
        actorId: userId,
        actorType: 'manager',
      });

      res.status(201).json({
        success: true,
        data: {
          ...confirmed,
          customerName,
          customerPhone,
          bookedBy: userId,
        },
      });
    } catch (err) { next(err); }
  }
);

// ── Validate QR / Check-in ───────────────────────────────────────────────────

router.post('/organizations/:organizationId/validate-qr',
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { token } = req.body;

      if (!token) throw new AppError('QR token is required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const qr = await turfQRRepository.findByToken(token);
      if (!qr) {
        return res.status(404).json({ success: true, data: { valid: false, reason: 'QR ticket not found' } });
      }

      const booking = await turfBookingRepository.findById(qr.booking_id);
      if (!booking) {
        return res.status(404).json({ success: true, data: { valid: false, reason: 'Booking not found' } });
      }

      if (booking.organization_id !== orgId) {
        return res.status(403).json({ success: true, data: { valid: false, reason: 'This booking does not belong to your organization' } });
      }

      // Verify HMAC signature on the QR ticket
      let qrDataPayload: { ticket?: string; slot?: string; venue?: number } | null = null;
      if (qr.qr_data) {
        try { qrDataPayload = JSON.parse(qr.qr_data); } catch { /* ignore parse errors */ }
      }
      const signature = qr.metadata && typeof qr.metadata === 'object' ? (qr.metadata as any).signature || null : null;
      const ticketUuid = qrDataPayload?.ticket || token;
      const slotStart = qrDataPayload?.slot || '';
      const sigResult = UniversalTicketService.verify({
        domain: 'turf',
        ticketUuid,
        entityId: booking.venue_id,
        startAt: slotStart,
        signature,
      });
      if (!sigResult.valid) {
        return res.status(400).json({
          success: true,
          data: { valid: false, reason: sigResult.reason || 'Invalid QR signature — ticket may be forged' },
        });
      }

      // Try check-in (validates all conditions internally)
      let updated;
      try {
        updated = await turfBookingService.checkInBooking(booking.id, token, {
          actorId: userId,
          actorType: 'manager',
        });
      } catch (checkInErr) {
        const reason = (checkInErr instanceof AppError)
          ? checkInErr.message
          : 'Check-in failed';
        return res.status(400).json({ success: true, data: { valid: false, reason } });
      }

      const userResult = await getPool().query(
        'SELECT username, phone FROM users WHERE id = $1', [booking.user_id]
      );
      const user = userResult.rows[0];

      return res.json({
        success: true,
        data: {
          valid: true,
          message: 'Checked in successfully',
          booking: {
            reference: booking.booking_reference,
            customerName: user?.username || 'Customer',
            customerPhone: user?.phone || '',
            status: updated?.status || booking.status,
          },
        },
      });
    } catch (err) { next(err); }
  }
);

// ── Manager Cancel Booking ───────────────────────────────────────────────────

router.post('/organizations/:organizationId/bookings/:bookingId/cancel',
  async (req, res, next) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const bookingId = Number(req.params.bookingId);
      const { reason } = req.body;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const booking = await turfBookingRepository.findById(bookingId);
      if (!booking) throw new AppError('Booking not found', 404);
      if (booking.organization_id !== orgId) throw new AppError('Booking not in your organization', 403);

      const cancelled = await turfBookingService.cancelBooking(bookingId, booking.user_id, reason || 'Cancelled by manager', {
        actorId: userId,
        actorType: 'manager',
      });

      res.json({ success: true, data: cancelled });
    } catch (err) { next(err); }
  }
);

// ── Attendance ───────────────────────────────────────────────────────────────

router.get('/organizations/:organizationId/attendance',
  async (req, res, next) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date, venueId, resourceId } = req.query;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const where = ['b.organization_id = $1'];
      const params: unknown[] = [orgId];
      let idx = 2;

      if (date) {
        const dayStart = `${date}T00:00:00Z`;
        const dayEnd = `${date}T23:59:59Z`;
        where.push(`au.starts_at >= $${idx++}`); params.push(dayStart);
        where.push(`au.starts_at <= $${idx++}`); params.push(dayEnd);
      }
      if (venueId) { where.push(`b.venue_id = $${idx++}`); params.push(venueId); }
      if (resourceId) { where.push(`b.resource_id = $${idx++}`); params.push(resourceId); }

      const { rows } = await getPool().query(
        `SELECT b.id, b.booking_reference, b.booking_type, b.status, b.amount, b.created_at,
                au.starts_at, au.ends_at,
                u.username as customer_name, u.phone as customer_phone,
                r.name as resource_name, v.name as venue_name,
                q.status as qr_status
         FROM turf_bookings b
         JOIN turf_availability_units au ON b.availability_unit_id = au.id
         JOIN users u ON b.user_id = u.id
         JOIN turf_resources r ON b.resource_id = r.id
         JOIN turf_venues v ON b.venue_id = v.id
         LEFT JOIN turf_qr_tickets q ON q.booking_id = b.id
         WHERE ${where.join(' AND ')}
         ORDER BY au.starts_at DESC`,
        params
      );

      res.json({ success: true, data: { bookings: rows } });
    } catch (err) { next(err); }
  }
);

// ── Daily Report ─────────────────────────────────────────────────────────────

router.get('/organizations/:organizationId/daily-report',
  async (req, res, next) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date } = req.query;

      if (!date) throw new AppError('date (YYYY-MM-DD) required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const dayStart = `${date}T00:00:00Z`;
      const dayEnd = `${date}T23:59:59Z`;

      const [onlineResult, offlineResult] = await Promise.all([
        getPool().query(
          `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
           FROM turf_bookings WHERE organization_id = $1 AND booking_type = 'online'
             AND created_at >= $2 AND created_at <= $3
             AND status NOT IN ('cancelled', 'refunded', 'expired')`,
          [orgId, dayStart, dayEnd]
        ),
        getPool().query(
          `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
           FROM turf_bookings WHERE organization_id = $1 AND booking_type = 'offline'
             AND created_at >= $2 AND created_at <= $3
             AND status NOT IN ('cancelled', 'refunded', 'expired')`,
          [orgId, dayStart, dayEnd]
        ),
      ]);

      res.json({
        success: true,
        data: {
          date,
          online: onlineResult.rows[0],
          offline: offlineResult.rows[0],
        },
      });
    } catch (err) { next(err); }
  }
);

// ── Entry Logs ───────────────────────────────────────────────────────────────

router.get('/organizations/:organizationId/entry-logs',
  async (req, res, next) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date, limit = 50 } = req.query;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE user_id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const where = ['b.organization_id = $1', "q.status = 'used'"];
      const params: unknown[] = [orgId];
      let idx = 2;

      if (date) {
        where.push(`q.used_at >= $${idx++}`); params.push(`${date}T00:00:00Z`);
        where.push(`q.used_at <= $${idx++}`); params.push(`${date}T23:59:59Z`);
      }

      const { rows } = await getPool().query(
        `SELECT q.id, q.used_at, b.booking_type, b.status,
                u.username as customer_name, u.phone as customer_phone,
                v.name as venue_name, r.name as resource_name
         FROM turf_qr_tickets q
         JOIN turf_bookings b ON q.booking_id = b.id
         JOIN users u ON b.user_id = u.id
         JOIN turf_resources r ON b.resource_id = r.id
         JOIN turf_venues v ON b.venue_id = v.id
         WHERE ${where.join(' AND ')}
         ORDER BY q.used_at DESC LIMIT $${idx}`,
        [...params, limit]
      );

      res.json({ success: true, data: { entries: rows } });
    } catch (err) { next(err); }
  }
);

export { router as turfManagerRoutes };
