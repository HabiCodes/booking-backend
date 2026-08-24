/**
 * Redis client — single shared instance for the entire application.
 *
 * Used by:
 *  - Turf slot locking (critical — DB authoritative, Redis is fast-path)
 *  - Turf booking idempotency (critical)
 *  - Movie seat holds (critical — with DB fallback)
 *  - Session revocation (important)
 *  - Distributed rate limiting (important)
 *  - Socket.IO cross-instance adapter (important)
 *
 * Failure policy by use case:
 *  - Critical: Callers must handle Redis failure and degrade gracefully
 *  - Important: Callers may fail-open or degrade
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: Redis | null = null;
let _isAvailable = false;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      // Exponential backoff: 100ms, 200ms, 400ms, then cap at 2s
      retryStrategy: (times) => {
        if (times > 10) return null; // Give up after 10 retries
        return Math.min(100 * Math.pow(2, times - 1), 2000);
      },
      // Connection timeout
      connectTimeout: 5000,
      // Auto-reconnect on connection drops
      enableOfflineQueue: true,
    });

    client.on('connect', () => {
      _isAvailable = true;
      logger.info('[Redis] connected');
    });

    client.on('ready', () => {
      _isAvailable = true;
      logger.info('[Redis] ready');
    });

    client.on('error', (err) => {
      _isAvailable = false;
      // Only log unexpected errors, not normal disconnects
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ECONNREFUSED' && nodeErr.code !== 'ENOTFOUND') {
        logger.error('[Redis] connection error:', err.message);
      }
    });

    client.on('close', () => {
      _isAvailable = false;
      logger.warn('[Redis] connection closed');
    });

    client.on('reconnecting', () => {
      logger.warn('[Redis] reconnecting...');
    });

    client.on('end', () => {
      _isAvailable = false;
      logger.warn('[Redis] connection ended');
    });
  }

  return client;
}

export function closeRedis(): void {
  if (client) {
    try {
      client.disconnect();
    } catch {
      // ignore
    }
    client = null;
    _isAvailable = false;
  }
}

/**
 * Check if Redis is available.
 * Performs a PING to verify the connection is alive.
 * Caches the result for subsequent calls within the TTL window.
 */
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = getRedis();
    await redis.ping();
    _isAvailable = true;
    return true;
  } catch {
    _isAvailable = false;
    return false;
  }
}

/**
 * Reset the availability cache. Called after connection events.
 */
export function resetRedisAvailability(): void {
  _isAvailable = false;
}