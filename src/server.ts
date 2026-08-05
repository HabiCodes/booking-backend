import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { getPool, closePool, runMigrations } from './db/pool';
import { notFoundHandler, errorHandler } from './middleware/errorHandler';
import { initSocketServer, getIo, broadcastBookingCount } from './sockets';
import { createServer } from 'http';
import authRoutes from './routes/authRoutes';
import eventRoutes from './routes/eventRoutes';
import bookingRoutes from './routes/bookingRoutes';
import scanRoutes from './routes/scanRoutes';
import adminRoutes from './routes/adminRoutes';
import adminProtectedRoutes from './routes/adminProtectedRoutes';
import { logger } from './utils/logger';

const app = express();
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

// Body parsing
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
});
app.use('/api/', limiter);

// Logging
if (config.nodeEnv !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg: string) => logger.info(msg.trim()) },
  }));
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', environment: config.nodeEnv });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminProtectedRoutes);

// 404
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Initialize
async function start() {
  try {
    // Verify DB connection
    const pool = getPool();

    const conn = await pool.connect();
    conn.release();

    logger.info('Database connection verified');

    await runMigrations();

    logger.info('Database migrations completed');

    // Init Socket.IO
    initSocketServer(server);

    // Start server
    server.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} (${config.nodeEnv})`);
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

start().then(() => initialBroadcast());

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
