/**
 * Lightweight in-memory rate limiter.
 *
 * For production, swap for a Redis-backed implementation.
 * The interface matches express-rate-limit so swapping is trivial.
 */

import { Request, Response, NextFunction } from 'express';

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  message?: string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketEntry>();

function prune(now: number): void {
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

export function rateLimiter(opts: RateLimiterOptions) {
  const { windowMs, max, keyGenerator, message } = opts;
  const fallbackKey = (req: Request): string => req.ip ?? 'unknown';

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (buckets.size > 10_000) prune(now);

    const key = (keyGenerator ?? fallbackKey)(req);
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > max) {
      const retryIn = existing.resetAt - now;
      res.setHeader('Retry-After', String(Math.ceil(retryIn / 1000)));
      res.status(429).json({
        success: false,
        message: message ?? 'Too many requests, please try again later.',
      });
      return;
    }

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - existing.count)));
    next();
  };
}

// Common presets
export const authRateLimiter = rateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
});

/**
 * Rate limiter for email resend.  Tighter than authRateLimiter because each
 * request triggers an outbound email (costly and spammy).  Allowed: 5
 * requests per rolling hour from the same IP / identity.
 */
export const resendVerificationLimiter = rateLimiter({
  windowMs: 60 * 60_000,
  max: 5,
  message: 'Too many verification emails requested. Please try again later.',
});

/**
 * Rate limiter for OTP verification.  5 attempts per rolling 15-minute
 * window keyed on (email + IP) so one attacker can't exhaust another
 * legitimate user's attempts.
 */
export const otpVerifyLimiter = rateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  keyGenerator: (req) => {
    const body = req.body as { email?: string } | undefined;
    const email = body?.email ? body.email.toLowerCase().trim() : '';
    const ip = req.ip ?? 'unknown';
    return `otp:${ip}:${email}`;
  },
  message: 'Too many OTP verification attempts. Please try again later.',
});

export const apiRateLimiter = rateLimiter({
  windowMs: 60_000,
  max: 100,
});