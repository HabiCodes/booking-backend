"use strict";
/**
 * Lightweight in-memory rate limiter.
 *
 * For production, swap for a Redis-backed implementation.
 * The interface matches express-rate-limit so swapping is trivial.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiRateLimiter = exports.resendVerificationLimiter = exports.authRateLimiter = void 0;
exports.rateLimiter = rateLimiter;
const buckets = new Map();
function prune(now) {
    for (const [key, entry] of buckets.entries()) {
        if (entry.resetAt <= now)
            buckets.delete(key);
    }
}
function rateLimiter(opts) {
    const { windowMs, max, keyGenerator, message } = opts;
    const fallbackKey = (req) => req.ip ?? 'unknown';
    return (req, res, next) => {
        const now = Date.now();
        if (buckets.size > 10000)
            prune(now);
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
exports.authRateLimiter = rateLimiter({
    windowMs: 15 * 60000,
    max: 20,
    message: 'Too many authentication attempts, please try again later.',
});
/**
 * Rate limiter for email resend.  Tighter than authRateLimiter because each
 * request triggers an outbound email (costly and spammy).  Allowed: 5
 * requests per rolling hour from the same IP / identity.
 */
exports.resendVerificationLimiter = rateLimiter({
    windowMs: 60 * 60000,
    max: 5,
    message: 'Too many verification emails requested. Please try again later.',
});
exports.apiRateLimiter = rateLimiter({
    windowMs: 60000,
    max: 100,
});
