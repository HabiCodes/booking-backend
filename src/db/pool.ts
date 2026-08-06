/**
 * PostgreSQL connection pool.
 *
 * Supports either a single DATABASE_URL (preferred for managed Postgres)
 * or individual DB_HOST/DB_USER/etc. variables (local dev).
 */

import { Pool, PoolClient } from 'pg';
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

    logger.info(`PostgreSQL pool initialized (max=${config.db.connectionLimit})`);
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
