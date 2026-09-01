/**
 * Turf Manager Routes — offline booking, QR validation, attendance, reports.
 *
 * Uses the organizer auth middleware (organizer JWT) + organization scoping.
 */

import { Router } from 'express';
import { organizerAuthMiddleware } from '../middleware/organizerAuth';
import { requireOrganizerPermission } from '../middleware/organizerPermissions';
import { organizerWriteRateLimiter } from '../middleware/rateLimiter';
import { enforceVenueAccess } from '../middleware/venueAccess';
import crypto from "crypto";
import { AppError } from '../middleware/errorHandler';
import { turfBookingService } from '../services/turfBookingService';
import { turfBookingRepository } from '../repositories/turfBookingRepository';
import { turfAvailabilityRepository } from '../repositories/turfAvailabilityRepository';
import { turfQRRepository } from '../repositories/turfQRRepository';
import { turfResourceRepository } from '../repositories/turfResourceRepository';
import { turfVenueRepository } from '../repositories/turfVenueRepository';
import { UniversalTicketService } from '../services/universalTicketService';
import { paymentOrderRepository } from '../repositories/paymentOrderRepository';
import { logger } from '../utils/logger';
import { getPool } from '../db/pool';

const router = Router();

// All manager routes require organizer authentication
router.use(organizerAuthMiddleware);

// Type guard for organizer requests
type OrganizerHandler = (req: any, res: any, next: any) => any;
const withWriteRate = (handler: OrganizerHandler): OrganizerHandler[] =>
  [organizerWriteRateLimiter, handler as unknown as OrganizerHandler];

// ── Offline Booking (Walk-in) ────────────────────────────────────────────────

router.post('/organizations/:organizationId/offline-booking',
  requireOrganizerPermission('organizer:offline_bookings:write'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { availabilityUnitId, customerName, customerPhone, quantity = 1 } = req.body;

      if (!availabilityUnitId) throw new AppError('availabilityUnitId is required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
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

      // Enforce assigned_venue_ids boundary
      enforceVenueAccess((req as any).organizerUser?.assignedVenueIds || [], venue.id);

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
        amount: undefined,  // use server-calculated pricing
      }, { actorId: userId, actorType: 'manager' });

      // ── Create payment_orders row and mark COMPLETED (offline/counter payment) ──
      // confirmBooking requires a payment_orders row with status COMPLETED.
      // We create one inline matching the movie offline booking pattern.
      const orderId = `OFTF_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const bookingAmount = parseFloat(booking.booking.amount);
      await paymentOrderRepository.create({
        order_id: orderId,
        booking_id: booking.booking.id,
        organization_id: orgId,
        event_id: null,
        amount: bookingAmount,
        currency: 'INR',
        idempotency_key: `turf_offline_pay_${booking.booking.id}`,
        payment_gateway: 'offline',
        financial_snapshot: null,
      });
      await paymentOrderRepository.updateFromWebhook(orderId, {
        status: 'COMPLETED',
        payment_method: 'offline_counter',
        provider_payment_id: `manual_offline_${Date.now()}`,
      });

      // Confirm the booking (now that payment_orders row exists with COMPLETED)
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
  requireOrganizerPermission('organizer:tickets:scan'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { token } = req.body;

      if (!token) throw new AppError('QR token is required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
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

      // Enforce assigned_venue_ids boundary
      try { enforceVenueAccess((req as any).organizerUser.assignedVenueIds || [], booking.venue_id); }
      catch (venueErr) {
        return res.status(403).json({ success: true, data: { valid: false, reason: (venueErr as AppError).message } });
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
  requireOrganizerPermission('organizer:bookings:cancel'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const bookingId = Number(req.params.bookingId);
      const { reason } = req.body;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const booking = await turfBookingRepository.findById(bookingId);
      if (!booking) throw new AppError('Booking not found', 404);
      if (booking.organization_id !== orgId) throw new AppError('Booking not in your organization', 403);

      // Enforce assigned_venue_ids boundary
      enforceVenueAccess((req as any).organizerUser.assignedVenueIds || [], booking.venue_id);

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
  requireOrganizerPermission('organizer:bookings:read'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date, venueId, resourceId } = req.query;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const where = ['b.organization_id = $1'];
      const params: unknown[] = [orgId];
      let idx = 2;

      if (date) {
        const dayStart = `${date}T00:00:00Z`;
        const nextDayStart = `${date}T00:00:00Z`;
        const dt = new Date(date + 'T00:00:00Z');
        dt.setUTCDate(dt.getUTCDate() + 1);
        const dayEnd = dt.toISOString().slice(0, 19) + 'Z';
        where.push(`au.starts_at >= $${idx++}`); params.push(dayStart);
        where.push(`au.starts_at < $${idx++}`); params.push(dayEnd);
      }
      if (venueId) { where.push(`b.venue_id = $${idx++}`); params.push(venueId); }
      if (resourceId) { where.push(`b.resource_id = $${idx++}`); params.push(resourceId); }

      // Enforce assigned_venue_ids — if manager is restricted, filter to their venues
      const assignedVenueIds = req.organizerUser!.assignedVenueIds || [];
      if (assignedVenueIds.length > 0) {
        if (!venueId) { where.push(`b.venue_id = ANY($${idx++})`); params.push(assignedVenueIds); }
        else if (!assignedVenueIds.includes(Number(venueId))) {
          return res.json({ success: true, data: { bookings: [] } });
        }
      }

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
  requireOrganizerPermission('organizer:analytics:read'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date } = req.query;

      if (!date) throw new AppError('date (YYYY-MM-DD) required', 400);

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const assignedVenueIds = req.organizerUser!.assignedVenueIds || [];
      const dayStart = `${date}T00:00:00Z`;
      const dt = new Date(date + 'T00:00:00Z');
      dt.setUTCDate(dt.getUTCDate() + 1);
      const dayEnd = dt.toISOString().slice(0, 19) + 'Z';

      const [onlineResult, offlineResult] = await Promise.all([
        getPool().query(
          `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
           FROM turf_bookings WHERE organization_id = $1 AND booking_type = 'online'
             AND created_at >= $2 AND created_at <= $3
             AND status NOT IN ('cancelled', 'refunded', 'expired')
             ${assignedVenueIds.length > 0 ? 'AND venue_id = ANY($4)' : ''}`,
          assignedVenueIds.length > 0 ? [orgId, dayStart, dayEnd, assignedVenueIds] : [orgId, dayStart, dayEnd]
        ),
        getPool().query(
          `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
           FROM turf_bookings WHERE organization_id = $1 AND booking_type = 'offline'
             AND created_at >= $2 AND created_at <= $3
             AND status NOT IN ('cancelled', 'refunded', 'expired')
             ${assignedVenueIds.length > 0 ? 'AND venue_id = ANY($4)' : ''}`,
          assignedVenueIds.length > 0 ? [orgId, dayStart, dayEnd, assignedVenueIds] : [orgId, dayStart, dayEnd]
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
  requireOrganizerPermission('organizer:bookings:read'),
  async (req: any, res: any, next: any) => {
    try {
      const userId = req.organizerUser?.id;
      if (!userId) throw new AppError('Unauthorized', 401);

      const orgId = Number(req.params.organizationId);
      const { date, limit = 50 } = req.query;

      // Verify manager belongs to organization
      const orgUser = await getPool().query(
        'SELECT id FROM organizer_users WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [userId, orgId]
      );
      if (!orgUser.rows.length) throw new AppError('You do not manage this organization', 403);

      const where = ['b.organization_id = $1', "q.status = 'used'"];
      const params: unknown[] = [orgId];
      let idx = 2;

      // Enforce assigned_venue_ids
      const assignedVenueIds = req.organizerUser!.assignedVenueIds || [];
      if (assignedVenueIds.length > 0) {
        where.push(`b.venue_id = ANY($${idx++})`);
        params.push(assignedVenueIds);
      }

      if (date) {
        where.push(`q.used_at >= $${idx++}`); params.push(`${date}T00:00:00Z`);
        const dt2 = new Date(date + 'T00:00:00Z');
        dt2.setUTCDate(dt2.getUTCDate() + 1);
        where.push(`q.used_at < $${idx++}`); params.push(dt2.toISOString().slice(0, 19) + 'Z');
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
