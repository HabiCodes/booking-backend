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
import { unifiedWebhookRoutes } from './routes/unifiedWebhookRoutes';
import { turfManagerRoutes } from './routes/turfManagerRoutes';
import { runTurfWorkers } from './workers/turfWorkers';
import { runMovieWorkers } from './workers/movieWorkers';
import { tryAcquireWorkerLock, releaseWorkerLock } from './infrastructure/workerLock';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './infrastructure/schedulerLock';
import { authRateLimiter, apiRateLimiter, createDistributedRateLimiter } from './infrastructure/distributedRateLimiter';
import { createRedisIoAdapter } from './infrastructure/redisSocketAdapter';
import { startAvailabilitySchedulerWithLock } from './services/turfAvailabilityScheduler';
import { movieRoutes } from './routes/movies';
import { movieScanRoutes } from './routes/movieScanRoutes';
import { adminMovieRouter } from './routes/movieAdmin';
import { layoutVersionRoutes } from './routes/layoutVersionRoutes';
import { organizerMovieRouter } from './routes/movieManagerRoutes';
import ownerDashboardRoutes from './routes/ownerDashboardRoutes';
import ownerManagerRoutes from './routes/ownerManagerRoutes';
import { organizerInvitationRoutes } from './routes/organizerInvitationRoutes';
import { assertValidEnvOrExit } from './utils/envValidation';
import { authRepository } from './repositories/authRepository';

// Security headers — hardened for production
function securityHeaders(_req: any, res: any, next: any): void {
  if (config.nodeEnv === 'production') {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    // Content-Security-Policy: api server — no inline scripts, no eval
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
    // Remove server identification
    res.removeHeader('X-Powered-By');
  }
  next();
}

// Run env validation before any other initialization
assertValidEnvOrExit();

const app = express();

// Trust Render's proxy so rate-limit and IP-based middleware see the
// real client address from X-Forwarded-For instead of the internal proxy IP.
app.set('trust proxy', 1);

const server = createServer(app);

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(securityHeaders);

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
  if (req.method === 'POST' && req.path.startsWith('/webhooks/')) {
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

// Global API rate limiter (process-scoped, but all instances share Redis-backed sub-limiters)
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', globalLimiter);

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

apiV1.use('/auth', authRateLimiter, authRoutes);
apiV1.use('/events', eventRoutes);
apiV1.use('/bookings', bookingRoutes);
apiV1.use('/turf/admin', turfAdminRoutes);
apiV1.use('/turf/organizer', turfOrganizerRoutes);
apiV1.use('/turf/manager', turfManagerRoutes);
apiV1.use('/turf/payments', turfPaymentRoutes);
apiV1.use('/webhooks', unifiedWebhookRoutes);
apiV1.use('/turf', turfCustomerRoutes);
apiV1.use('/owner', ownerDashboardRoutes);
apiV1.use('/owner', ownerManagerRoutes);
apiV1.use('/scan', scanRoutes);
apiV1.use('/scan/movies', movieScanRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/admin', adminProtectedRoutes);
apiV1.use('/promotions', promotionPublicRoutes);
apiV1.use('/promotions/organizer', promotionOrganizerRoutes);
apiV1.use('/promotions/admin', promotionAdminRoutes);
apiV1.use('/organizer/auth', organizerAuthRoutes);
apiV1.use('/organizer/events', organizerEventRoutes);
apiV1.use('/organizer/organizations', organizerOrganizationRoutes);
apiV1.use('/organizer/applications', organizerApplicationRoutes);
apiV1.use('/movies', movieRoutes);
apiV1.use('/admin/movies', adminMovieRouter);
apiV1.use('/admin/layout-versions', layoutVersionRoutes);
apiV1.use('/owner/invitations', organizerInvitationRoutes.owner);
apiV1.use('/invitations', organizerInvitationRoutes.public);
apiV1.use('/organizer/movies', organizerMovieRouter);

app.use('/api/v1', apiV1);

// ── Legacy /api routes (backward compatibility) ───────────────────────────────

app.use('/api/auth', authRateLimiter, authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/turf/admin', turfAdminRoutes);
app.use('/api/turf/organizer', turfOrganizerRoutes);
app.use('/api/turf/manager', turfManagerRoutes);
app.use('/api/turf/payments', turfPaymentRoutes);
app.use('/api/webhooks', unifiedWebhookRoutes);
app.use('/api/turf', turfCustomerRoutes);
app.use('/api/owner', ownerDashboardRoutes);
app.use('/api/owner', ownerManagerRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/scan/movies', movieScanRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminProtectedRoutes);
app.use('/api/organizer/auth', organizerAuthRoutes);
app.use('/api/organizer/events', organizerEventRoutes);
app.use('/api/organizer/organizations', organizerOrganizationRoutes);
app.use('/api/organizer/applications', organizerApplicationRoutes);
app.use('/api/movies', movieRoutes);
app.use('/api/admin/movies', adminMovieRouter);
app.use('/api/admin/layout-versions', layoutVersionRoutes);
app.use('/api/organizer/movies', organizerMovieRouter);

// ── API documentation ────────────────────────────────────────────────────────

app.use('/docs', docsRoutes);

// ── 404 ──────────────────────────────────────────────────────────────────────

app.use(notFoundHandler);

// ── Error handler (must be last) ──────────────────────────────────────────────

app.use(errorHandler);

// ── Initialize (migrations + setup before accepting traffic) ─────────────────

async function start() {
  try {
    // Verify DB connection and apply migrations BEFORE listening.
    // This ensures no instance serves traffic with a stale schema.
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
    // already past their TTL or that were never collected.
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

    // Init Socket.IO with Redis adapter for cross-instance communication
    initSocketServer(server);

    // Start availability scheduler with distributed lock (rolling 15-day window)
    if (config.nodeEnv !== 'test') {
      startAvailabilitySchedulerWithLock();
    }

    // Background workers: expire stale bookings and holds
    // Run once at boot to clean up any stale state from previous session
    if (config.nodeEnv !== 'test') {
      try {
        const turfBootLock = await tryAcquireWorkerLock('turf-workers-boot', 600_000);
        if (turfBootLock) {
          try {
            await runTurfWorkers('all');
            logger.info('Background workers completed initial turf sweep');
          } catch (err) {
            logger.warn('Initial turf worker sweep failed (non-fatal):', err as Error);
          } finally {
            await releaseWorkerLock('turf-workers-boot');
          }
        }

        const movieBootLock = await tryAcquireWorkerLock('movie-workers-boot', 600_000);
        if (movieBootLock) {
          try {
            await runMovieWorkers('all');
            logger.info('Background workers completed initial movie sweep');
          } catch (err) {
            logger.warn('Initial movie worker sweep failed (non-fatal):', err as Error);
          } finally {
            await releaseWorkerLock('movie-workers-boot');
          }
        }
      } catch (err) {
        logger.warn('Initial worker sweep setup failed (non-fatal):', err as Error);
      }

      // Schedule periodic worker runs with distributed lock
      // Only one API instance executes workers per interval.
      const WORKER_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
      const WORKER_LOCK_TTL_MS = 4 * 60_000; // 4 min — slightly less than interval

      async function runScheduledWorkers(): Promise<void> {
        const turfLocked = await tryAcquireWorkerLock('turf-workers', WORKER_LOCK_TTL_MS);
        if (turfLocked) {
          try {
            await runTurfWorkers('expire');
          } catch (err) {
            logger.error('Turf worker error:', err as Error);
          } finally {
            await releaseWorkerLock('turf-workers');
          }
        }

        const movieLocked = await tryAcquireWorkerLock('movie-workers', WORKER_LOCK_TTL_MS);
        if (movieLocked) {
          try {
            await runMovieWorkers('expire');
          } catch (err) {
            logger.error('Movie worker error:', err as Error);
          } finally {
            await releaseWorkerLock('movie-workers');
          }
        }
      }

      setInterval(runScheduledWorkers, WORKER_INTERVAL_MS);
      logger.info('Background workers scheduled every 5 minutes (distributed lock)');
    }

    // Ensure upload directories exist
    ensureUploadDirs();

    // ── Start listening ONLY after all initialization is complete ──────────────
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
    await broadcastBookingCount(id, bookedCount, capacity);
  } catch {
    // silent — startup shouldn't fail if DB is empty
  }
}

// Auto-start only when not in test mode (tests import server.ts for the app object)
if (process.env.NODE_ENV !== 'test') {
  start().then(() => initialBroadcast());
}

// Graceful shutdown
let isShuttingDown = false;
let shutdownComplete = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn(`${signal} received again — already shutting down`);
    return;
  }
  isShuttingDown = true;
  shutdownComplete = false;
  logger.info(`${signal} received — starting graceful shutdown`);

  // 1. Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed — no new connections accepted');
  });

  // Force-close only if cleanup hasn't completed within the drain period
  const DRAIN_MS = 30_000;
  const forceTimer = setTimeout(async () => {
    if (!shutdownComplete) {
      logger.warn('Drain period expired — forcing exit (cleanup incomplete)');
      process.exit(1);
    }
  }, DRAIN_MS);

  try {
    // 2. Close Socket.IO
    const { closeSocketServer } = await import('./sockets');
    closeSocketServer();
    logger.info('Socket.IO closed');

    // 3. Stop availability scheduler
    const { stopAvailabilityScheduler } = await import('./services/turfAvailabilityScheduler');
    stopAvailabilityScheduler();
    logger.info('Availability scheduler stopped');
  } catch {
    // Non-fatal
  }

  // 4. Close Redis
  const { closeRedis } = await import('./db/redis');
  closeRedis();
  logger.info('Redis connection closed');

  // 5. Close database pool
  await closePool();
  logger.info('Database pool closed');

  // Cleanup complete — cancel the force timer and exit 0
  shutdownComplete = true;
  clearTimeout(forceTimer);
  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export { app, server, getIo };