import dotenv from 'dotenv';
dotenv.config();

function asInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Database config — supports either a single `DATABASE_URL` (preferred for
 * Render's managed PostgreSQL) or individual `DB_HOST`/`DB_USER`/etc.
 * variables (useful for local dev).
 */
const dbUrl = process.env.DATABASE_URL;
const useConnectionString = typeof dbUrl === 'string' && dbUrl.trim().length > 0;

export const config = {
  port: asInt(process.env.PORT, 4000),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    connectionString: useConnectionString ? dbUrl : null,
    host: process.env.DB_HOST || 'localhost',
    port: asInt(process.env.DB_PORT, 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'event_booking',
    connectionLimit: asInt(process.env.DB_CONNECTION_LIMIT, 20),
    ssl: asBool(process.env.DB_SSL, false),
    runMigrationsOnBoot: asBool(process.env.DB_RUN_MIGRATIONS, true),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-user-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    adminSecret: process.env.ADMIN_JWT_SECRET || 'change-me-admin-secret',
    adminExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
  },

  corsOrigin: process.env.CORS_ORIGIN || '*',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  socketPort: asInt(process.env.SOCKET_PORT, 0),

  rateLimit: {
    /**
     * Global per-IP window. Default: 300 req / 60s.
     */
    windowMs: asInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: asInt(process.env.RATE_LIMIT_MAX, 300),
    /**
     * Stricter cap for write/auth endpoints (per-IP).
     */
    authMax: asInt(process.env.RATE_LIMIT_AUTH_MAX, 20),
  },

  logging: {
    /**
     * Set LOG_FILE_ENABLED=false on read-only filesystems (e.g. Render's
     * container) to skip disk transports.
     */
    fileEnabled: asBool(process.env.LOG_FILE_ENABLED, true),
  },

  admin: {
    seedEmail: process.env.ADMIN_EMAIL || '',
    seedPassword: process.env.ADMIN_PASSWORD || '',
    seedName: process.env.ADMIN_NAME || 'Admin',
    seedOnBoot: asBool(process.env.ADMIN_SEED_ON_BOOT, false),
  },

  bookings: {
    /**
     * Hard ceiling on a single booking request. Anti-abuse at the API edge.
     */
    maxTicketsPerBooking: asInt(process.env.BOOKING_MAX_TICKETS, 10),
    /**
     * Per-user-per-event cap. Prevents one user from snap-buying an entire
     * event and starving legitimate buyers.
     */
    maxTicketsPerUserPerEvent: asInt(process.env.BOOKING_MAX_PER_USER, 10),
    /**
     * Default cancellation window (hours before start_at) when an event
     * hasn't overridden it. Individual events win via events.cancel_window_hours.
     */
    defaultCancelWindowHours: asInt(process.env.BOOKING_CANCEL_WINDOW_HOURS, 6),
    /**
     * QR signing secret. Hot-swap by rotating this and disposing of old codes.
     * In production this MUST be a long random string.
     */
    qrSigningSecret: process.env.QR_SIGNING_SECRET || process.env.JWT_SECRET || 'change-me-qr-secret',
  },

  uploads: {
    baseDir: process.env.UPLOAD_DIR || './uploads',
    maxFileSizeBytes: asInt(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
    maxEventImageBytes: asInt(process.env.UPLOAD_EVENT_MAX_BYTES, 5 * 1024 * 1024),
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
    directories: {
      events: 'events',
      banners: 'banners',
      tickets: 'tickets',
    },
    bannerMinWidth: 800,
    bannerMinHeight: 200,
    bannerIdealWidth: 1600,
    bannerIdealHeight: 400,
  },
} as const;

export type AppConfig = typeof config;
