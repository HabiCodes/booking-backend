"use strict";
/**
 * PostgreSQL connection pool.
 *
 * Supports either a single DATABASE_URL (preferred for managed Postgres)
 * or individual DB_HOST/DB_USER/etc. variables (local dev).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = getPool;
exports.closePool = closePool;
exports.withTransaction = withTransaction;
const pg_1 = require("pg");
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
let pool = null;
function getPool() {
    if (!pool) {
        const connectionConfig = config_1.config.db.connectionString
            ? { connectionString: config_1.config.db.connectionString }
            : {
                host: config_1.config.db.host,
                port: config_1.config.db.port,
                user: config_1.config.db.user,
                password: config_1.config.db.password,
                database: config_1.config.db.database,
            };
        pool = new pg_1.Pool({
            ...connectionConfig,
            max: config_1.config.db.connectionLimit,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            ssl: config_1.config.db.ssl ? { rejectUnauthorized: false } : undefined,
        });
        pool.on('error', (err) => {
            logger_1.logger.error('PostgreSQL pool error:', err);
        });
        logger_1.logger.info(`PostgreSQL pool initialized (max=${config_1.config.db.connectionLimit})`);
    }
    return pool;
}
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
async function withTransaction(work) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
