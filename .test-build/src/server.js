"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getIo = exports.server = exports.app = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const morgan_1 = __importDefault(require("morgan"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const config_1 = require("./config");
const pool_1 = require("./db/pool");
const migrations_1 = require("./db/migrations");
const errorHandler_1 = require("./middleware/errorHandler");
const sockets_1 = require("./sockets");
Object.defineProperty(exports, "getIo", { enumerable: true, get: function () { return sockets_1.getIo; } });
const http_1 = require("http");
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const eventRoutes_1 = __importDefault(require("./routes/eventRoutes"));
const bookingRoutes_1 = __importDefault(require("./routes/bookingRoutes"));
const scanRoutes_1 = __importDefault(require("./routes/scanRoutes"));
const adminRoutes_1 = __importDefault(require("./routes/adminRoutes"));
const adminProtectedRoutes_1 = __importDefault(require("./routes/adminProtectedRoutes"));
const promotionRoutes_1 = require("./routes/promotionRoutes");
const organizerAuthRoutes_1 = __importDefault(require("./routes/organizerAuthRoutes"));
const organizerEventRoutes_1 = __importDefault(require("./routes/organizerEventRoutes"));
const organizerOrganizationRoutes_1 = __importDefault(require("./routes/organizerOrganizationRoutes"));
const logger_1 = require("./utils/logger");
const uploadService_1 = require("./services/uploadService");
const healthController_1 = require("./controllers/healthController");
const docsRoutes_1 = __importDefault(require("./routes/docsRoutes"));
const turfRoutes_1 = require("./routes/turfRoutes");
const turfOrganizerRoutes_1 = require("./routes/turfOrganizerRoutes");
const turfAdminRoutes_1 = require("./routes/turfAdminRoutes");
const turfPaymentRoutes_1 = require("./routes/turfPaymentRoutes");
const turfWebhookRoutes_1 = require("./routes/turfWebhookRoutes");
const turfManagerRoutes_1 = require("./routes/turfManagerRoutes");
const ownerDashboardRoutes_1 = __importDefault(require("./routes/ownerDashboardRoutes"));
const ownerManagerRoutes_1 = __importDefault(require("./routes/ownerManagerRoutes"));
const envValidation_1 = require("./utils/envValidation");
const authRepository_1 = require("./repositories/authRepository");
// Run env validation before any other initialization
(0, envValidation_1.assertValidEnvOrExit)();
const app = (0, express_1.default)();
exports.app = app;
const server = (0, http_1.createServer)(app);
exports.server = server;
// Security
app.use((0, helmet_1.default)({ contentSecurityPolicy: false }));
// CORS
app.use((0, cors_1.default)({
    origin: config_1.config.corsOrigin,
    credentials: true,
}));
// Compression
app.use((0, compression_1.default)());
// ── Body parsing ──────────────────────────────────────────────────────────────
// Raw body capture must happen BEFORE JSON parsing so webhook signature
// verification can use the exact original bytes.
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.startsWith('/turf/webhooks/')) {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            req.rawBody = Buffer.concat(chunks);
            next();
        });
    }
    else {
        next();
    }
});
app.use(express_1.default.json({ limit: '100kb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '100kb' }));
// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = (0, express_rate_limit_1.default)({
    windowMs: config_1.config.rateLimit.windowMs,
    max: config_1.config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', globalLimiter);
// Tighter limiter for auth endpoints
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: config_1.config.rateLimit.windowMs,
    max: config_1.config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
});
// ── Logging ───────────────────────────────────────────────────────────────────
if (config_1.config.nodeEnv !== 'test') {
    app.use((0, morgan_1.default)('combined', {
        stream: { write: (msg) => logger_1.logger.info(msg.trim()) },
    }));
}
// ── Health endpoints (unversioned, always available) ─────────────────────────
app.get('/health/live', healthController_1.liveness);
app.get('/health/ready', healthController_1.readiness);
app.get('/health/shutdown', healthController_1.shutdown);
// ── API v1 (versioned — use this for all new consumers) ──────────────────────
const apiV1 = express_1.default.Router();
apiV1.use('/auth', authLimiter, authRoutes_1.default);
apiV1.use('/events', eventRoutes_1.default);
apiV1.use('/bookings', bookingRoutes_1.default);
apiV1.use('/turf', turfRoutes_1.turfCustomerRoutes);
apiV1.use('/turf/payments', turfPaymentRoutes_1.turfPaymentRoutes);
apiV1.use('/turf/webhooks', turfWebhookRoutes_1.turfWebhookRoutes);
apiV1.use('/turf/manager', turfManagerRoutes_1.turfManagerRoutes);
apiV1.use('/turf/organizer', turfOrganizerRoutes_1.turfOrganizerRoutes);
apiV1.use('/turf/admin', turfAdminRoutes_1.turfAdminRoutes);
apiV1.use('/owner', ownerDashboardRoutes_1.default);
apiV1.use('/owner', ownerManagerRoutes_1.default);
apiV1.use('/scan', scanRoutes_1.default);
apiV1.use('/admin', adminRoutes_1.default);
apiV1.use('/admin', adminProtectedRoutes_1.default);
apiV1.use('/promotions', promotionRoutes_1.promotionPublicRoutes);
apiV1.use('/promotions/organizer', promotionRoutes_1.promotionOrganizerRoutes);
apiV1.use('/promotions/admin', promotionRoutes_1.promotionAdminRoutes);
app.use('/api/v1', apiV1);
// ── Legacy /api routes (backward compatibility) ───────────────────────────────
app.use('/api/auth', authLimiter, authRoutes_1.default);
app.use('/api/events', eventRoutes_1.default);
app.use('/api/bookings', bookingRoutes_1.default);
app.use('/api/turf', turfRoutes_1.turfCustomerRoutes);
app.use('/api/turf/payments', turfPaymentRoutes_1.turfPaymentRoutes);
app.use('/api/turf/webhooks', turfWebhookRoutes_1.turfWebhookRoutes);
app.use('/api/turf/manager', turfManagerRoutes_1.turfManagerRoutes);
app.use('/api/turf/organizer', turfOrganizerRoutes_1.turfOrganizerRoutes);
app.use('/api/turf/admin', turfAdminRoutes_1.turfAdminRoutes);
app.use('/api/owner', ownerDashboardRoutes_1.default);
app.use('/api/owner', ownerManagerRoutes_1.default);
app.use('/api/scan', scanRoutes_1.default);
app.use('/api/admin', adminRoutes_1.default);
app.use('/api/admin', adminProtectedRoutes_1.default);
app.use('/api/organizer/auth', organizerAuthRoutes_1.default);
app.use('/api/organizer/events', organizerEventRoutes_1.default);
app.use('/api/organizer/organizations', organizerOrganizationRoutes_1.default);
// ── API documentation ────────────────────────────────────────────────────────
app.use('/docs', docsRoutes_1.default);
// ── 404 ──────────────────────────────────────────────────────────────────────
app.use(errorHandler_1.notFoundHandler);
// ── Error handler (must be last) ──────────────────────────────────────────────
app.use(errorHandler_1.errorHandler);
// ── Initialize ────────────────────────────────────────────────────────────────
async function start() {
    try {
        // Verify DB connection and apply migrations.
        // Connection failure is non-fatal (server can serve cached/public routes),
        // but migration failure IS fatal — the schema is inconsistent.
        let poolAvailable = false;
        try {
            const pool = (0, pool_1.getPool)();
            const conn = await pool.connect();
            conn.release();
            logger_1.logger.info('Database connection verified');
            poolAvailable = true;
        }
        catch (connErr) {
            const message = connErr instanceof Error ? connErr.message : String(connErr);
            logger_1.logger.warn('Database connection failed (server will start without DB): ' + message);
        }
        if (poolAvailable) {
            try {
                await (0, migrations_1.runMigrations)();
                logger_1.logger.info('Database migrations completed');
            }
            catch (migrationErr) {
                logger_1.logger.error('Database migrations FAILED — server cannot start safely:', migrationErr);
                logger_1.logger.error('Fix the migration and redeploy. The process will now exit.');
                process.exit(1);
            }
        }
        // Background sweep: drop any pending registrations whose OTPs are
        // already past their TTL or that were never collected.  We log the
        // count when meaningful so ops can spot a spike in forgotten sign-ups.
        if (poolAvailable) {
            try {
                const dropped = await authRepository_1.authRepository.cleanupExpiredPendingRegistrations();
                if (dropped > 0) {
                    logger_1.logger.info(`[otp] cleaned up ${dropped} expired pending registration(s) at boot`);
                }
            }
            catch (cleanupErr) {
                logger_1.logger.warn('[otp] boot-time pending-registration cleanup failed (non-fatal):', cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr));
            }
        }
        // Init Socket.IO
        (0, sockets_1.initSocketServer)(server);
        // Ensure upload directories exist
        (0, uploadService_1.ensureUploadDirs)();
        // Start server
        server.listen(config_1.config.port, () => {
            logger_1.logger.info(`Server running on port ${config_1.config.port} (${config_1.config.nodeEnv})`);
            logger_1.logger.info(`API v1:  /api/v1`);
            logger_1.logger.info(`Legacy:  /api  (deprecated)`);
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to start server:', err);
        process.exit(1);
    }
}
// Broadcast booking stats on startup (event ID 1)
async function initialBroadcast() {
    try {
        const pool = (0, pool_1.getPool)();
        const result = await pool.query(`SELECT e.id, e.capacity,
              COALESCE(SUM(b.ticket_count), 0) AS "bookedCount"
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
       WHERE e.id = (SELECT MIN(id) FROM events)
       GROUP BY e.capacity`);
        const row = result.rows[0];
        if (!row)
            return;
        const id = Number(row.id);
        const capacity = Number(row.capacity);
        const bookedCount = Number(row.bookedCount) || 0;
        (0, sockets_1.broadcastBookingCount)(id, bookedCount, capacity);
    }
    catch {
        // silent — startup shouldn't fail if DB is empty
    }
}
// Auto-start only when not in test mode (tests import server.ts for the app object)
if (process.env.NODE_ENV !== 'test') {
    start().then(() => initialBroadcast());
}
// Graceful shutdown
process.on('SIGTERM', async () => {
    logger_1.logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        (0, pool_1.closePool)();
        process.exit(0);
    });
});
process.on('SIGINT', async () => {
    server.close(() => {
        (0, pool_1.closePool)();
        process.exit(0);
    });
});
