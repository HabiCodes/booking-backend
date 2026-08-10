/**
 * Redis client — single shared instance for the entire application.
 *
 * Used by:
 *  - Turf slot locking
 *  - Turf booking idempotency
 *  - Search caching (future)
 *  - Rate limiting (future)
 */

import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../utils/logger';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 10) return null; // Give up after 10 retries
        return Math.min(times * 200, 2000);
      },
    });

    client.on('connect', () => {
      logger.info('[Redis] connected');
    });

    client.on('error', (err) => {
      logger.error('[Redis] connection error:', err.message);
    });

    client.on('reconnecting', () => {
      logger.warn('[Redis] reconnecting...');
    });
  }

  return client;
}

export function closeRedis(): void {
  if (client) {
    client.disconnect();
    client = null;
  }
}

// Check if Redis is available
export async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = getRedis();
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
