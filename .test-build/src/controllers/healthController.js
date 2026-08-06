"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.liveness = liveness;
exports.readiness = readiness;
exports.shutdown = shutdown;
const express_1 = require("express");
const pool_1 = require("../db/pool");
const logger_1 = require("../utils/logger");
function respond(res, payload, httpStatus) {
    res.status(httpStatus).json(payload);
}
// ── Liveness: process is alive ───────────────────────────────────────────────
function liveness(_req, res) {
    respond(res, {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    }, 200);
}
// ── Readiness: all subsystems reachable ─────────────────────────────────────
async function readiness(_req, res) {
    const checks = {};
    let overallStatus = 'ok';
    // ── PostgreSQL ─────────────────────────────────────────────────────────────
    try {
        const { rows } = await (0, pool_1.getPool)().query('SELECT 1 AS ok');
        checks.db = {
            status: 'ok',
            response: rows.length > 0 ? 'ok' : 'empty',
        };
    }
    catch (err) {
        logger_1.logger.warn('Readiness check: database unreachable', { error: err.message });
        checks.db = { status: 'error', error: err.message };
        overallStatus = 'degraded';
    }
    // ── Result ─────────────────────────────────────────────────────────────────
    const payload = {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        checks,
    };
    respond(res, payload, overallStatus === 'ok' ? 200 : 503);
}
// ── Shutdown: graceful drain ─────────────────────────────────────────────────
async function shutdown(_req, res) {
    logger_1.logger.info('Shutdown endpoint called — closing connections');
    try {
        await (0, pool_1.closePool)();
    }
    catch (err) {
        logger_1.logger.warn('Error closing pool during shutdown', { error: err.message });
    }
    res.status(200).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
    process.exit(0);
}
const router = (0, express_1.Router)();
router.get('/live', liveness);
router.get('/ready', readiness);
router.get('/shutdown', shutdown);
exports.default = router;
