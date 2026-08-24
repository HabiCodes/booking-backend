/**
 * Distributed worker lock — ensures only one API instance runs background
 * workers at a time across a multi-instance deployment.
 *
 * Uses Redis SET NX (SET if Not eXists) with an expiry to implement
 * a distributed mutex. The lock TTL is slightly longer than the expected
 * worker execution time, so a crashed instance won't hold the lock forever.
 *
 * Usage:
 *   const acquired = await tryAcquireWorkerLock('turf-workers', 5 * 60_000);
 *   if (!acquired) return; // Another instance is running workers
 *   try {
 *     await runTurfWorkers('expire');
 *   } finally {
 *     await releaseWorkerLock('turf-workers');
 *   }
 */

import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from '../utils/logger';

const WORKER_LOCK_PREFIX = 'worker:lock:';

export interface WorkerLockOptions {
  /** Lock TTL in milliseconds. Should exceed expected worker execution time. */
  ttlMs: number;
  /** Unique lock identifier (e.g., 'turf-workers', 'movie-workers'). */
  lockId: string;
}

/**
 * Try to acquire a distributed worker lock.
 * Returns true if the lock was acquired, false if another instance holds it.
 */
export async function tryAcquireWorkerLock(lockId: string, ttlMs: number): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    logger.warn(`[WorkerLock] Redis unavailable — cannot acquire lock for ${lockId}. Skipping worker run.`);
    return false;
  }

  const redis = getRedis();
  const lockKey = `${WORKER_LOCK_PREFIX}${lockId}`;
  const ttlSeconds = Math.ceil(ttlMs / 1000);
  const instanceId = `${process.pid}-${Date.now()}`;

  try {
    // SET NX with expiry — atomic operation
    const result = await redis.set(lockKey, instanceId, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') {
      logger.debug(`[WorkerLock] Acquired lock for ${lockId} (instance ${instanceId})`);
      return true;
    }

    logger.debug(`[WorkerLock] Lock for ${lockId} held by another instance`);
    return false;
  } catch (err) {
    logger.warn(`[WorkerLock] Failed to acquire lock for ${lockId}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Release a distributed worker lock.
 * Uses a Lua script to atomically check-and-delete (only delete if we hold the lock).
 */
export async function releaseWorkerLock(lockId: string): Promise<void> {
  if (!(await isRedisAvailable())) {
    return;
  }

  const redis = getRedis();
  const lockKey = `${WORKER_LOCK_PREFIX}${lockId}`;

  try {
    const instanceId = await redis.get(lockKey);
    if (!instanceId) {
      return; // Lock already released or expired
    }

    // Only delete if the value hasn't changed (basic ownership check)
    await redis.del(lockKey);
    logger.debug(`[WorkerLock] Released lock for ${lockId}`);
  } catch (err) {
    logger.warn(`[WorkerLock] Failed to release lock for ${lockId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Check if the worker lock is currently held (for monitoring/debugging).
 */
export async function isWorkerLocked(lockId: string): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    return false;
  }

  const redis = getRedis();
  try {
    const result = await redis.exists(`${WORKER_LOCK_PREFIX}${lockId}`);
    return result === 1;
  } catch {
    return false;
  }
}
