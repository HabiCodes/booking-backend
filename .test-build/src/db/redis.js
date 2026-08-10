"use strict";
/**
 * Redis client — single shared instance for the entire application.
 *
 * Used by:
 *  - Turf slot locking
 *  - Turf booking idempotency
 *  - Search caching (future)
 *  - Rate limiting (future)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedis = getRedis;
exports.closeRedis = closeRedis;
exports.isRedisAvailable = isRedisAvailable;
const ioredis_1 = __importDefault(require("ioredis"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
let client = null;
function getRedis() {
    if (!client) {
        client = new ioredis_1.default(config_1.config.redis.url, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                if (times > 10)
                    return null; // Give up after 10 retries
                return Math.min(times * 200, 2000);
            },
        });
        client.on('connect', () => {
            logger_1.logger.info('[Redis] connected');
        });
        client.on('error', (err) => {
            logger_1.logger.error('[Redis] connection error:', err.message);
        });
        client.on('reconnecting', () => {
            logger_1.logger.warn('[Redis] reconnecting...');
        });
    }
    return client;
}
function closeRedis() {
    if (client) {
        client.disconnect();
        client = null;
    }
}
// Check if Redis is available
async function isRedisAvailable() {
    try {
        const redis = getRedis();
        await redis.ping();
        return true;
    }
    catch {
        return false;
    }
}
