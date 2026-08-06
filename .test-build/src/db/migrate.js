"use strict";
/**
 * Database Migration Runner — CLI entrypoint
 *
 * Run with:  npm run db:migrate
 *
 * Applies all pending migrations from migrations/versions/*.sql
 * Idempotent — re-running is a no-op once everything is current.
 *
 * Excluded from `tsc -p tsconfig.json` build (see tsconfig.json exclude).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const pool_1 = require("./pool");
const migrations_1 = require("./migrations");
const logger_1 = require("../utils/logger");
async function main() {
    try {
        const pool = (0, pool_1.getPool)();
        // Force pool init by issuing a no-op query
        await pool.query('SELECT 1');
        logger_1.logger.info('Running PostgreSQL migrations…');
        const applied = await (0, migrations_1.runMigrations)();
        logger_1.logger.info(`Migrations complete — ${applied.length} applied this run.`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger_1.logger.error(`Migration failed: ${message}`);
        process.exitCode = 1;
    }
    finally {
        await (0, pool_1.closePool)();
    }
}
void main();
