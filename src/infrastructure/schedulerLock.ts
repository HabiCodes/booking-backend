/**
 * Distributed scheduler lock — ensures only one API instance runs scheduled
 * tasks (like availability bootstrap and extension) at a time.
 *
 * Uses Redis SET NX with an extended TTL so that a crashed instance
 * does not permanently hold the lock.
 */

import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from '../utils/logger';

const SCHEDULER_LOCK_PREFIX = 'scheduler:lock:';

export async function tryAcquireSchedulerLock(lockId: string, ttlSeconds: number): Promise<boolean> {
  if (!(await isRedisAvailable())) {
    logger.warn(`[SchedulerLock] Redis unavailable — skipping scheduler task: ${lockId}`);
    return false;
  }

  const redis = getRedis();
  const lockKey = `${SCHEDULER_LOCK_PREFIX}${lockId}`;
  const instanceId = `${process.pid}-${Date.now()}`;

  try {
    const result = await redis.set(lockKey, instanceId, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn(`[SchedulerLock] Failed to acquire lock for ${lockId}:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function releaseSchedulerLock(lockId: string): Promise<void> {
  if (!(await isRedisAvailable())) return;

  const redis = getRedis();
  try {
    await redis.del(`${SCHEDULER_LOCK_PREFIX}${lockId}`);
  } catch {
    // Non-critical
  }
}
