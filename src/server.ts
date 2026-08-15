import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { getPool, closePool } from './db/pool';
import { runMigrations } from './db/migrations';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { initSocketServer, getIo, broadcastBookingCount } from './sockets';
import { createServer } from 'http';
import authRoutes from './routes/authRoutes';
import eventRoutes from './routes/eventRoutes';
import bookingRoutes from './routes/bookingRoutes';
import scanRoutes from './routes/scanRoutes';
import adminRoutes from './routes/adminRoutes';
import adminProtectedRoutes from './routes/adminProtectedRoutes';
import { promotionPublicRoutes, promotionOrganizerRoutes, promotionAdminRoutes } from './routes/promotionRoutes';
import organizerAuthRoutes from './routes/organizerAuthRoutes';
import organizerEventRoutes from './routes/organizerEventRoutes';
import organizerOrganizationRoutes from './routes/organizerOrganizationRoutes';
import { organizerApplicationRoutes } from './routes/organizerApplicationRoutes';
import { logger } from './utils/logger';
import { ensureUploadDirs } from './services/uploadService';
import {
  liveness,
  readiness,
  shutdown as healthShutdown,
} from './controllers/healthController';
import docsRoutes from './routes/docsRoutes';
import { turfCustomerRoutes } from './routes/turfRoutes';
import { turfOrganizerRoutes } from './routes/turfOrganizerRoutes';
import { turfAdminRoutes } from './routes/turfAdminRoutes';
import { turfPaymentRoutes } from './routes/turfPaymentRoutes';
import { turfWebhookRoutes } from './routes/turfWebhookRoutes';
import { turfManagerRoutes } from './routes/turfManagerRoutes';
import ownerDashboardRoutes from './routes/ownerDashboardRoutes';
import ownerManagerRoutes from './routes/ownerManagerRoutes';
import { assertValidEnvOrExit } from './utils/envValidation';
import { authRepository } from './repositories/authRepository';

// Run env validation before any other initialization
assertValidEnvOrExit();

const app = express();

// Trust Render's proxy so rate-limit and IP-based middleware see the
// real client address from X-Forwarded-For instead of the internal proxy IP.
app.set('trust proxy', 1);

const server = createServer(app);

// Security
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));

// Compression
app.use(compression());

// ── Body parsing ──────────────────────────────────────────────────────────────
// Raw body capture must happen BEFORE JSON parsing so webhook signature
// verification can use the exact original bytes.
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/turf/webhooks/')) {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      (req as any).rawBody = Buffer.concat(chunks);
      next();
    });
  } else {
    next();
  }
});
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────

const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

// Tighter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Logging ───────────────────────────────────────────────────────────────────

if (config.nodeEnv !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg: string) => logger.info(msg.trim()) },
  }));
}

// ── Health endpoints (unversioned, always available) ─────────────────────────

app.get('/health/live', liveness);
app.get('/health/ready', readiness);
app.get('/health/shutdown', healthShutdown);

// ── API v1 (versioned — use this for all new consumers) ──────────────────────

const apiV1 = express.Router();

apiV1.use('/auth', authLimiter, authRoutes);
apiV1.use('/events', eventRoutes);
apiV1.use('/bookings', bookingRoutes);
apiV1.use('/turf/admin', turfAdminRoutes);
apiV1.use('/turf/organizer', turfOrganizerRoutes);
apiV1.use('/turf/manager', turfManagerRoutes);
apiV1.use('/turf/payments', turfPaymentRoutes);
apiV1.use('/turf/webhooks', turfWebhookRoutes);
apiV1.use('/turf', turfCustomerRoutes);
apiV1.use('/owner', ownerDashboardRoutes);
apiV1.use('/owner', ownerManagerRoutes);
apiV1.use('/scan', scanRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/admin', adminProtectedRoutes);
apiV1.use('/promotions', promotionPublicRoutes);
apiV1.use('/promotions/organizer', promotionOrganizerRoutes);
apiV1.use('/promotions/admin', promotionAdminRoutes);

app.use('/api/v1', apiV1);

// ── Legacy /api routes (backward compatibility) ───────────────────────────────

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/turf/admin', turfAdminRoutes);
app.use('/api/turf/organizer', turfOrganizerRoutes);
app.use('/api/turf/manager', turfManagerRoutes);
app.use('/api/turf/payments', turfPaymentRoutes);
app.use('/api/turf/webhooks', turfWebhookRoutes);
app.use('/api/turf', turfCustomerRoutes);
app.use('/api/owner', ownerDashboardRoutes);
app.use('/api/owner', ownerManagerRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminProtectedRoutes);
app.use('/api/organizer/auth', organizerAuthRoutes);
app.use('/api/organizer/events', organizerEventRoutes);
app.use('/api/organizer/organizations', organizerOrganizationRoutes);
app.use('/api/organizer/applications', organizerApplicationRoutes);

// ── API documentation ────────────────────────────────────────────────────────

app.use('/docs', docsRoutes);

// ── 404 ──────────────────────────────────────────────────────────────────────

app.use(notFoundHandler);

// ── Error handler (must be last) ──────────────────────────────────────────────

app.use(errorHandler);

// ── Initialize ────────────────────────────────────────────────────────────────

async function start() {
  try {
    // Verify DB connection and apply migrations.
    // Connection failure is non-fatal (server can serve cached/public routes),
    // but migration failure IS fatal — the schema is inconsistent.
    let poolAvailable = false;
    try {
      const pool = getPool();
      const conn = await pool.connect();
      conn.release();
      logger.info('Database connection verified');
      poolAvailable = true;
    } catch (connErr) {
      const message = connErr instanceof Error ? connErr.message : String(connErr);
      logger.warn('Database connection failed (server will start without DB): ' + message);
    }

    if (poolAvailable) {
      try {
        await runMigrations();
        logger.info('Database migrations completed');
      } catch (migrationErr) {
        logger.error('Database migrations FAILED — server cannot start safely:', migrationErr as Error);
        logger.error('Fix the migration and redeploy. The process will now exit.');
        process.exit(1);
      }
    }

    // Background sweep: drop any pending registrations whose OTPs are
    // already past their TTL or that were never collected.  We log the
    // count when meaningful so ops can spot a spike in forgotten sign-ups.
    if (poolAvailable) {
      try {
        const dropped = await authRepository.cleanupExpiredPendingRegistrations();
        if (dropped > 0) {
          logger.info(`[otp] cleaned up ${dropped} expired pending registration(s) at boot`);
        }
      } catch (cleanupErr) {
        logger.warn(
          '[otp] boot-time pending-registration cleanup failed (non-fatal):',
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        );
      }
    }

    // Init Socket.IO
    initSocketServer(server);

    // Ensure upload directories exist
    ensureUploadDirs();

    // Start server
    server.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} (${config.nodeEnv})`);
      logger.info(`API v1:  /api/v1`);
      logger.info(`Legacy:  /api  (deprecated)`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err as Error);
    process.exit(1);
  }
}

// Broadcast booking stats on startup (event ID 1)
async function initialBroadcast() {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT e.id, e.capacity,
              COALESCE(SUM(b.ticket_count), 0) AS "bookedCount"
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       WHERE e.id = (SELECT MIN(id) FROM events)
       GROUP BY e.capacity`,
    );
    const row = result.rows[0];
    if (!row) return;
    const id = Number(row.id);
    const capacity = Number(row.capacity);
    const bookedCount = Number(row.bookedCount) || 0;
    broadcastBookingCount(id, bookedCount, capacity);
  } catch {
    // silent — startup shouldn't fail if DB is empty
  }
}

// Auto-start only when not in test mode (tests import server.ts for the app object)
if (process.env.NODE_ENV !== 'test') {
  start().then(() => initialBroadcast());
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    closePool();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  server.close(() => {
    closePool();
    process.exit(0);
  });
});

export { app, server, getIo };