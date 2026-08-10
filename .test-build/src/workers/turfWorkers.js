"use strict";
/**
 * Turf Workers — background jobs for slot expiration and booking completion.
 *
 * Run via: node dist/workers/turfWorkers.js
 * Or schedule via cron (every 5 min): node dist/workers/turfWorkers.js expire
 */
Object.defineProperty(exports, "__esModule", { value: true });
const turfBookingService_1 = require("../services/turfBookingService");
const turfAvailabilityEngine_1 = require("../services/turfAvailabilityEngine");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
// ── Workers ──────────────────────────────────────────────────────────────────
async function expireStaleBookings() {
    try {
        const count = await turfBookingService_1.turfBookingService.expireStaleBookings();
        logger_1.logger.info(`[TurfWorker] expireStaleBookings done: ${count} expired`);
    }
    catch (err) {
        logger_1.logger.error('[TurfWorker] expireStaleBookings failed:', err);
    }
}
async function completeEndedSlots() {
    try {
        const count = await turfBookingService_1.turfBookingService.completeEndedSlots();
        logger_1.logger.info(`[TurfWorker] completeEndedSlots done: ${count} completed`);
    }
    catch (err) {
        logger_1.logger.error('[TurfWorker] completeEndedSlots failed:', err);
    }
}
async function expireStaleHolds() {
    try {
        const count = await turfAvailabilityEngine_1.availabilityEngine.expireStaleHolds();
        logger_1.logger.info(`[TurfWorker] expireStaleHolds done: ${count} expired`);
    }
    catch (err) {
        logger_1.logger.error('[TurfWorker] expireStaleHolds failed:', err);
    }
}
async function reconcileStaleLocks() {
    try {
        const count = await turfAvailabilityEngine_1.availabilityEngine.reconcileStaleLocks();
        logger_1.logger.info(`[TurfWorker] reconcileStaleLocks done: ${count} reconciled`);
    }
    catch (err) {
        logger_1.logger.error('[TurfWorker] reconcileStaleLocks failed:', err);
    }
}
// ── Entry Point ──────────────────────────────────────────────────────────────
async function main() {
    const job = (process.argv[2] || 'all');
    logger_1.logger.info(`[TurfWorker] Starting job: ${job}`);
    try {
        if (job === 'expire' || job === 'all') {
            await expireStaleBookings();
            await expireStaleHolds();
            await reconcileStaleLocks();
        }
        if (job === 'complete' || job === 'all') {
            await completeEndedSlots();
        }
        logger_1.logger.info(`[TurfWorker] Job ${job} completed`);
    }
    catch (err) {
        logger_1.logger.error(`[TurfWorker] Job ${job} failed:`, err);
        process.exitCode = 1;
    }
    finally {
        await (0, pool_1.closePool)();
    }
}
main();
