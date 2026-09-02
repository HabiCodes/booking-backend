/**
 * Distributed Redis-backed rate limiter.
 *
 * Replaces the previous in-memory limiter so multiple API instances share the
 * same counter (required for horizontal scaling).
 *
 * Algorithm: fixed-window counter with INCR + EXPIRE.
 *  - First INCR creates the key with EXPIRE = window
 *  - Subsequent INCRs within the window increment the same key
 *  - If count > max, request is rejected with 429 + Retry-After
 *
 * Failure policy (security-critical):
 *  - Redis UNREACHABLE → FAIL CLOSED on security-sensitive limiters
 *    (auth, OTP, password reset, organizer write). This is a deliberate
 *    correctness choice: silently allowing unlimited auth attempts when the
 *    limit store is broken is worse than serving 503 for that traffic class.
 *  - Redis UNREACHABLE → FAIL OPEN on cosmetic limiters (global API,
 *    coupon) to preserve availability for normal traffic.
 *  - The `failClosed` option on each preset encodes which behavior applies.
 *
 * Headers emitted on every response:
 *  - X-RateLimit-Limit
 *  - X-RateLimit-Remaining
 *  - Retry-After (only on 429)
 */

import { Request, Response, NextFunction } from 'express';
import { getRedis, isRedisAvailable } from '../db/redis';
import { logger } from '../utils/logger';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
  /** Logical limiter name — used in Redis key, logs, and header comments. */
  name?: string;
  /**
   * When Redis is unreachable, fail closed (deny request) instead of open.
   * Default: false. SECURITY-CRITICAL limiters (auth, OTP, password reset)
   * MUST set this to true to prevent an attacker from disabling rate limits
   * by starving Redis.
   */
  failClosed?: boolean;
}

const buckets = new Map<string, { count: number; resetAt: number }>();
const MEMORY_FALLBACK_TTL_MS = 30_000;

function inMemoryAllow(key: string, max: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + Math.min(windowMs, MEMORY_FALLBACK_TTL_MS) });
    return { allowed: true, remaining: max - 1, retryAfterSec: 0 };
  }
  existing.count += 1;
  if (existing.count > max) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: Math.max(0, max - existing.count), retryAfterSec: 0 };
}

/**
 * INCR + EXPIRE atomic via a tiny Lua script so the TTL is set on first hit
 * and we don't get stuck keys if a previous attempt set the counter but
 * crashed before EXPIRE.
 */
const INCR_AND_EXPIRE = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export function rateLimiter(opts: RateLimiterOptions) {
  const { windowMs, max, keyGenerator, message, name, failClosed = false } = opts;
  const fallbackKey = (req: Request): string => req.ip ?? 'unknown';
  const limiterName = name ?? 'default';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = (keyGenerator ?? fallbackKey)(req);
    const redisKey = `rl:${limiterName}:${key}`;

    let redisOk = false;
    try {
      if (await isRedisAvailable()) {
        const redis = getRedis();
        const result = (await redis.eval(
          INCR_AND_EXPIRE,
          1,
          redisKey,
          String(windowMs),
        )) as [number, number];

        const count = Number(result[0]);
        const ttlMs = Number(result[1]);
        redisOk = true;

        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));

        if (count > max) {
          const retryAfterSec = ttlMs > 0 ? Math.ceil(ttlMs / 1000) : Math.ceil(windowMs / 1000);
          res.setHeader('Retry-After', String(retryAfterSec));
          res.status(429).json({
            success: false,
            message: message ?? 'Too many requests, please try again later.',
          });
          return;
        }
        next();
        return;
      }
    } catch (err) {
      logger.warn(
        `[RateLimiter:${limiterName}] Redis error, falling back:`,
        err instanceof Error ? err.message : String(err),
      );
      redisOk = false;
    }

    // Redis unreachable path.
    if (!redisOk) {
      if (failClosed) {
        // Security-critical limiter: deny request rather than allow unlimited.
        logger.warn(
          `[RateLimiter:${limiterName}] FAIL-CLOSED — Redis unavailable, denying request from ${req.ip ?? 'unknown'}`,
        );
        res.setHeader('Retry-After', '1');
        res.status(503).json({
          success: false,
          message:
            'Service temporarily unavailable. Please retry shortly.',
          code: 'RATE_LIMIT_BACKEND_UNAVAILABLE',
        });
        return;
      }
      // Non-critical limiter: graceful degradation using a short-lived in-memory
      // bucket so we don't lose all rate-limiting if Redis blips. The TTL is
      // intentionally short (MEMORY_FALLBACK_TTL_MS) so that once Redis returns,
      // the canonical counter takes over again.
      const fallback = inMemoryAllow(`${limiterName}:${key}`, max, windowMs);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(fallback.remaining));
      if (!fallback.allowed) {
        res.setHeader('Retry-After', String(fallback.retryAfterSec || 1));
        res.status(429).json({
          success: false,
          message: message ?? 'Too many requests, please try again later.',
        });
        return;
      }
      next();
      return;
    }
  };
}

// Common presets — values preserved from the previous in-memory limiter.
//
// failClosed is TRUE for security-critical limiters (auth, OTP, password reset,
// organizer write) so an attacker cannot disable rate limits by starving Redis.
// failClosed is FALSE for global / cosmetic limits so normal traffic stays up
// when Redis blips.

// SECURITY-CRITICAL — auth login attempts.
// 20 requests per 15 minutes per IP.
export const authRateLimiter = rateLimiter({
  name: 'auth',
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
  failClosed: true,
});

// SECURITY-CRITICAL — resend verification email (costly + spammy + enables
// account takeover via inbox flooding). 5 requests/hour.
export const resendVerificationLimiter = rateLimiter({
  name: 'resend-verification',
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many verification emails requested. Please try again later.',
  failClosed: true,
});

// SECURITY-CRITICAL — OTP verification attempts (5 per 15 min, keyed on
// email+IP so one attacker can't exhaust another's attempts).
export const otpVerifyLimiter = rateLimiter({
  name: 'otp-verify',
  windowMs: 15 * 60_000,
  max: 5,
  keyGenerator: (req) => {
    const body = req.body as { email?: string } | undefined;
    const email = body?.email ? body.email.toLowerCase().trim() : '';
    const ip = req.ip ?? 'unknown';
    return `otp:${ip}:${email}`;
  },
  message: 'Too many OTP verification attempts. Please try again later.',
  failClosed: true,
});

// NON-CRITICAL — global API throttle. 100 req/min per IP.
export const apiRateLimiter = rateLimiter({
  name: 'api-global',
  windowMs: 60_000,
  max: 100,
  failClosed: false,
});

// NON-CRITICAL — booking writes (anti-abuse only, not security-critical).
export const bookingRateLimiter = rateLimiter({
  name: 'booking',
  windowMs: 60_000,
  max: 15,
  message: 'Too many booking requests, please try again later.',
  failClosed: false,
});

// NON-CRITICAL — payment writes. Webhook verification has its own idempotency.
export const paymentRateLimiter = rateLimiter({
  name: 'payment',
  windowMs: 60_000,
  max: 30,
  message: 'Too many payment requests, please try again later.',
  failClosed: false,
});

// NON-CRITICAL — coupon validation.
export const couponRateLimiter = rateLimiter({
  name: 'coupon',
  windowMs: 60_000,
  max: 10,
  message: 'Too many coupon requests, please try again later.',
  failClosed: false,
});

// SECURITY-CRITICAL — organizer write operations (create/update/delete events,
// manage zones). 30/min per org. failClosed because a starved limiter could
// enable enumeration / mass-modification.
export const organizerWriteRateLimiter = rateLimiter({
  name: 'organizer-write',
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => {
    const organizer = (req as any).organizerUser;
    const orgId = organizer?.organizationId ?? 'unknown';
    return `organizer:write:${orgId}`;
  },
  message: 'Too many organizer requests, please try again later.',
  failClosed: true,
});

/**
 * Test-only helper: reset the in-memory fallback buckets. Not used in prod.
 */
export function _resetRateLimiterMemory(): void {
  buckets.clear();
}
