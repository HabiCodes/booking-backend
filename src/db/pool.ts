import { Pool, PoolClient, QueryResult } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionConfig = config.db.connectionString
      ? { connectionString: config.db.connectionString }
      : {
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.database,
        };

    pool = new Pool({
      ...connectionConfig,
      max: config.db.connectionLimit,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    });

    pool.on('error', (err) => {
      logger.error('PostgreSQL pool error:', err);
    });

    logger.info(`PostgreSQL pool initialized with limit ${config.db.connectionLimit}`);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(client?: PoolClient): Promise<void> {
  const target = client ?? getPool();
  const migrationSql = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  venue       VARCHAR(255) NOT NULL,
  banner_url  VARCHAR(512) DEFAULT NULL,
  logo_url    VARCHAR(512) DEFAULT NULL,
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ NOT NULL,
  capacity    INTEGER NOT NULL DEFAULT 2500,
  description TEXT DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id     BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  id              BIGSERIAL PRIMARY KEY,
  booking_id      BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  ticket_uuid     VARCHAR(36) NOT NULL UNIQUE,
  attendee_name   VARCHAR(255) NOT NULL,
  attendee_phone  VARCHAR(20) NOT NULL,
  attendee_age    INTEGER DEFAULT NULL,
  attendee_gender VARCHAR(10) DEFAULT NULL CHECK (attendee_gender IN ('male','female','other')),
  checked_in      BOOLEAN NOT NULL DEFAULT false,
  checked_in_at   TIMESTAMPTZ DEFAULT NULL,
  checked_in_by   BIGINT DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_bookings_user      ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_event     ON bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_uuid       ON tickets(ticket_uuid);
CREATE INDEX IF NOT EXISTS idx_tickets_booking    ON tickets(booking_id);
CREATE INDEX IF NOT EXISTS idx_tickets_checked_in ON tickets(checked_in);
CREATE INDEX IF NOT EXISTS idx_admins_email       ON admins(email);

INSERT INTO events (title, venue, start_at, end_at, capacity, description)
SELECT 'Grand Summer Gala 2026',
       'Grand Convention Center, Mumbai',
       '2026-12-15T18:00:00Z',
       '2026-12-15T23:00:00Z',
       2500,
       'The biggest event of the year.'
WHERE NOT EXISTS (SELECT 1 FROM events);
`;

  try {
    const result: QueryResult = await target.query(migrationSql);
    logger.info('PostgreSQL migrations applied');
  } catch (err) {
    logger.error('Migration failed:', err as Error);
    throw err;
  }
}
