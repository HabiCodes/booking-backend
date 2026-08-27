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
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    adminSecret: process.env.ADMIN_JWT_SECRET || '',
    adminExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
    organizerSecret: process.env.ORGANIZER_JWT_SECRET || '',
    organizerExpiresIn: process.env.ORGANIZER_JWT_EXPIRES_IN || '8h',
  },

  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3001',
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
     * MUST be set independently — never falls back to JWT secrets.
     */
    qrSigningSecret: process.env.QR_SIGNING_SECRET || '',
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

  // ── Payment Provider ────────────────────────────────────────────────────────
  /**
   * Payment provider configuration. Currently Federal Bank.
   * The provider-specific credentials live here; the adapter layer
   * translates these into provider API calls.
   *
   * Add new providers by extending the config — the domain layer never
   * sees provider details.
   */
  paymentProvider: {
    /** Provider key: 'federal_bank' | 'mock' (for dev/test) */
    provider: (process.env.PAYMENT_PROVIDER || 'federal_bank') as 'federal_bank' | 'mock',
    // Federal Bank credentials — replace placeholder values with real credentials
    merchantId: process.env.PAYMENT_MERCHANT_ID || '',
    merchantKey: process.env.PAYMENT_MERCHANT_KEY || '',
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
    /** Base URL for payment pages (customer-facing redirect) */
    returnUrl: process.env.PAYMENT_RETURN_URL || 'http://localhost:3001',
    /** Full webhook endpoint URL for the provider to call back */
    notifyUrl: process.env.PAYMENT_NOTIFY_URL || '',
  },

  // ── Redis ─────────────────────────────────────────────────────────────────────
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    slotLockTtlSeconds: asInt(process.env.REDIS_SLOT_LOCK_TTL, 120),
    idempotencyTtlSeconds: asInt(process.env.REDIS_IDEMPOTENCY_TTL, 86400),
    idempotencyInProgressTtlSeconds: asInt(process.env.REDIS_IDEMPOTENCY_IN_PROGRESS_TTL, 120),
    paymentExpirySeconds: asInt(process.env.PAYMENT_TIMEOUT_SECONDS, 300),
  },

  // ── Email (Hostinger) ────────────────────────────────────────────────────────
  email: {
    /**
     * Hostinger Mail API token. If absent, the app logs email content to the
     * console instead of actually sending.
     */
    hostingerApiToken: process.env.HOSTINGER_API_TOKEN || '',
    /**
     * Hostinger mailbox identifier. Used to build the per-mailbox send URL.
     */
    hostingerMailboxId: process.env.HOSTINGER_MAILBOX_ID || '',
    /**
     * From address for outbound emails.
     */
    from: process.env.EMAIL_FROM || 'info@bigmembres.in',
    /**
     * Public base URL used when building verification / password-reset links.
     * Falls back to APP_URL then to a sensible default.
     */
    appUrl: process.env.APP_URL || '',
    // Timeout per outbound email request (ms)
    timeoutMs: 10_000,
  },

  // ── OTP registration ─────────────────────────────────────────────────────────
  otp: {
    /** Length of the numeric OTP in digits (default 6). */
    codeLength: asInt(process.env.OTP_CODE_LENGTH, 6),
    /** How many minutes the OTP is valid (default 10). */
    expiryMinutes: asInt(process.env.OTP_EXPIRY_MINUTES, 10),
    /** Maximum verification attempts before the OTP is invalidated (default 5). */
    maxAttempts: asInt(process.env.OTP_MAX_ATTEMPTS, 5),
    /** Sweep interval for boot-time cleanup of expired pending registrations (minutes). */
    cleanupIntervalMinutes: asInt(process.env.OTP_CLEANUP_INTERVAL_MINUTES, 60),
  },
} as const;

export type AppConfig = typeof config;