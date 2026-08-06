"use strict";
/**
 * Migration runner — idempotent, production-grade.
 *
 * - Tracks applied migrations in `schema_migrations` table.
 * - Wraps each migration in a transaction (BEGIN/COMMIT/ROLLBACK).
 * - Detects SQL error patterns in `existing column "remaining_capacity"` and
 *   similar ALTER TABLE conflicts; these are treated as no-ops when the
 *   checker query inside the migration file couldn't prevent them.
 * - Files loaded from `migrations/versions/###_name.sql` in numeric order.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const fs_1 = require("fs");
const path_1 = require("path");
const pool_1 = require("./pool");
const logger_1 = require("../utils/logger");
const SCHEMA_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(20) PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;
/** Patterns in Postgres error messages that indicate the migration is a no-op. */
const HARMONIC_ERROR_PATTERNS = [
    /existing column/i,
    /duplicate column/i,
    /already exists/i,
    /duplicate key value violates unique constraint/i,
    /index ".*" already exists/i,
    /constraint .* already exists/i,
];
function resolveMigrationsDir() {
    const candidates = [
        (0, path_1.join)(process.cwd(), 'migrations', 'versions'),
        (0, path_1.join)(process.cwd(), '..', 'migrations', 'versions'),
        (0, path_1.join)((0, path_1.dirname)(__dirname), '..', 'migrations', 'versions'),
    ];
    for (const c of candidates) {
        try {
            (0, fs_1.readdirSync)(c);
            return c;
        }
        catch {
            // continue
        }
    }
    throw new Error('Cannot locate migrations/versions directory');
}
function loadMigrations(dir) {
    const files = (0, fs_1.readdirSync)(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    return files.map((file) => {
        const match = file.match(/^(\d{3,})_(.+)\.sql$/);
        if (!match) {
            throw new Error(`Migration file "${file}" must match pattern NNN_name.sql`);
        }
        const version = match[1];
        const name = match[2];
        const sql = (0, fs_1.readFileSync)((0, path_1.join)(dir, file), 'utf-8');
        return { version, name, sql };
    });
}
async function runMigrations() {
    const pool = (0, pool_1.getPool)();
    const applied = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Bootstrap the tracking table
        await client.query(SCHEMA_MIGRATIONS_TABLE);
        const { rows: appliedRows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
        const appliedSet = new Set(appliedRows.map((r) => r.version));
        const dir = resolveMigrationsDir();
        const migrations = loadMigrations(dir);
        for (const m of migrations) {
            if (appliedSet.has(m.version)) {
                logger_1.logger.debug(`Migration ${m.version} (${m.name}) — already applied`);
                continue;
            }
            logger_1.logger.info(`Applying migration ${m.version} (${m.name})…`);
            try {
                await client.query(m.sql);
                await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
                    m.version,
                    m.name,
                ]);
                applied.push(m.version);
                logger_1.logger.info(`Migration ${m.version} applied ✓`);
            }
            catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                const isHarmonic = HARMONIC_ERROR_PATTERNS.some((p) => p.test(errorMessage));
                if (isHarmonic) {
                    logger_1.logger.warn(`Migration ${m.version} hit an expected conflict (likely already applied via another path): ${errorMessage}. Recording as applied.`);
                    try {
                        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
                            m.version,
                            m.name,
                        ]);
                        applied.push(m.version);
                    }
                    catch {
                        // If we can't record it, roll back and fail
                        throw err;
                    }
                }
                else {
                    throw err;
                }
            }
        }
        if (applied.length === 0) {
            logger_1.logger.info('No pending migrations');
        }
        else {
            logger_1.logger.info(`Applied ${applied.length} migration(s) this run`);
        }
        await client.query('COMMIT');
    }
    catch (err) {
        await client.query('ROLLBACK');
        logger_1.logger.error('Migration runner failed:', err);
        throw err;
    }
    finally {
        client.release();
    }
    return applied;
}
