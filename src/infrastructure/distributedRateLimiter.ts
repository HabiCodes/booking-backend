/**
 * Distributed rate limiter — Redis-backed sliding window.
 *
 * Replaces the in-memory rate limiter for production use.
 * Uses Redis INCR + EXPIRE for atomic per-key counting.
 * Falls back to a no-op (allow all) if Redis is unavailable, since
 * rate limiting is non-critical — the global express-rate-limit middleware
 * still provides basic protection.
 */

import { Request, Response, NextFunction } from 'express';
import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from '../utils/logger';

interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  /** If true, allow all requests when Redis is down (fail-open). If false, block all (fail-closed). */
  skipIfRedisDown?: boolean;
}

interface CheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

async function checkRedisRateLimit(
  key: string,
  windowMs: number,
  max: number
): Promise<CheckResult> {
  const redis = getRedis();
  const windowSeconds = Math.ceil(windowMs / 1000);

  try {
    const result = await redis.multi()
      .incr(key)
      .expire(key, windowSeconds)
      .ttl(key)
      .exec();

    if (!result) {
      return { allowed: true, remaining: max, retryAfterMs: 0 };
    }

    const count = (result[0][1] as number) || 1;
    const ttlSeconds = (result[2][1] as number) || windowSeconds;

    if (count > max) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, ttlSeconds * 1000) };
    }

    return { allowed: true, remaining: max - count, retryAfterMs: 0 };
  } catch (err) {
    logger.warn('[RateLimiter] Redis check failed, allowing request:', err instanceof Error ? err.message : String(err));
    return { allowed: true, remaining: max, retryAfterMs: 0 };
  }
}

export function createDistributedRateLimiter(opts: RateLimiterOptions) {
  const { windowMs, max, keyGenerator, message, skipIfRedisDown = true } = opts;
  const fallbackKey = (req: Request): string => req.ip ?? 'unknown';
  const limitMessage = message ?? 'Too many requests, please try again later.';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!(await isRedisAvailable())) {
      if (skipIfRedisDown) {
        next();
        return;
      }
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(503).json({
        success: false,
        message: 'Service temporarily unavailable. Please try again later.',
      });
      return;
    }

    const key = keyGenerator ? keyGenerator(req) : fallbackKey(req);
    const rateLimitKey = `ratelimit:${key}`;
    const result = await checkRedisRateLimit(rateLimitKey, windowMs, max);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      if (result.retryAfterMs > 0) {
        res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      }
      res.status(429).json({
        success: false,
        message: limitMessage,
        retryInMs: result.retryAfterMs,
      });
      return;
    }

    next();
  };
}

// ── Presets (matching the original in-memory limits) ─────────────────────────

export const authRateLimiter = createDistributedRateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
  skipIfRedisDown: false,
});

export const resendVerificationLimiter = createDistributedRateLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many verification emails requested. Please try again later.',
  skipIfRedisDown: false,
});

export const otpVerifyLimiter = createDistributedRateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  keyGenerator: (req) => {
    const body = req.body as { email?: string } | undefined;
    const email = body?.email ? body.email.toLowerCase().trim() : '';
    const ip = req.ip ?? 'unknown';
    return `otp:${ip}:${email}`;
  },
  message: 'Too many OTP verification attempts. Please try again later.',
  skipIfRedisDown: false,
});

export const apiRateLimiter = createDistributedRateLimiter({
  windowMs: 60_000,
  max: 100,
});

export const bookingRateLimiter = createDistributedRateLimiter({
  windowMs: 60_000,
  max: 15,
  message: 'Too many booking requests, please try again later.',
  skipIfRedisDown: false,
});

export const paymentRateLimiter = createDistributedRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'Too many payment requests, please try again later.',
  skipIfRedisDown: false,
});

export const couponRateLimiter = createDistributedRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: 'Too many coupon requests, please try again later.',
});

export const adminLoginLimiter = createDistributedRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many admin login attempts. Please try again later.',
  skipIfRedisDown: false,
});

export const applicationSubmitLimiter = createDistributedRateLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many application submissions. Please try again later.',
});
