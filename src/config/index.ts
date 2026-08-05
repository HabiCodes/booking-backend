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

  admin: {
    seedEmail: process.env.ADMIN_EMAIL || '',
    seedPassword: process.env.ADMIN_PASSWORD || '',
    seedName: process.env.ADMIN_NAME || 'Admin',
    seedOnBoot: asBool(process.env.ADMIN_SEED_ON_BOOT, false),
  },
} as const;

export type AppConfig = typeof config;
