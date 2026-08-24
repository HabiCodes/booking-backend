import { Router, Request, Response } from 'express';
import { getPool, closePool } from '../db/pool';
import { isRedisAvailable } from '../db/redis';
import { logger } from '../utils/logger';
import { config } from '../config';

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  uptime: number;
  checks?: Record<string, unknown>;
  error?: string;
}

function respond(res: Response, payload: HealthResponse, httpStatus: number): void {
  res.status(httpStatus).json(payload);
}

// ── Liveness: process is alive ───────────────────────────────────────────────

export function liveness(_req: Request, res: Response): void {
  respond(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }, 200);
}

// ── Readiness: all subsystems reachable ─────────────────────────────────────

export async function readiness(_req: Request, res: Response): Promise<void> {
  const checks: Record<string, unknown> = {};
  let overallStatus: HealthResponse['status'] = 'ok';

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  try {
    const { rows } = await getPool().query('SELECT 1 AS ok');
    checks.db = {
      status: 'ok',
      response: rows.length > 0 ? 'ok' : 'empty',
    };
  } catch (err) {
    logger.warn('Readiness check: database unreachable', { error: (err as Error).message });
    checks.db = { status: 'error', error: (err as Error).message };
    overallStatus = 'degraded';
  }

  // ── Redis ──────────────────────────────────────────────────────────────────
  // Redis is critical for session management, rate limiting, and seat holds.
  try {
    const redisAvailable = await isRedisAvailable();
    checks.redis = {
      status: redisAvailable ? 'ok' : 'error',
    };
    if (!redisAvailable && overallStatus === 'ok') {
      overallStatus = 'degraded';
    }
  } catch (err) {
    checks.redis = { status: 'error', error: (err as Error).message };
    if (overallStatus === 'ok') overallStatus = 'degraded';
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  const payload: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  };

  respond(res, payload, overallStatus === 'ok' ? 200 : 503);
}

// ── Shutdown: graceful drain ─────────────────────────────────────────────────
//
// CRITICAL: This endpoint must NEVER be public. It is only reachable when a
// shared secret is presented in the `X-Shutdown-Key` header. The secret is
// configured via the `SHUTDOWN_KEY` env var (auto-generated via `openssl rand
// -hex 32` at deploy time). If unset, the endpoint is disabled entirely.
//
// Why: Without auth, anyone with network access could shut down the service.

const SHUTDOWN_HEADER = 'x-shutdown-key';

function isShutdownAuthorized(req: Request): boolean {
  const configuredKey = process.env.SHUTDOWN_KEY;
  if (!configuredKey || configuredKey.length < 16) {
    return false;
  }
  const presented = req.headers[SHUTDOWN_HEADER];
  if (typeof presented !== 'string' || presented.length === 0) {
    return false;
  }
  // Constant-time comparison to prevent timing attacks
  if (presented.length !== configuredKey.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < presented.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ configuredKey.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function shutdown(req: Request, res: Response): Promise<void> {
  if (!isShutdownAuthorized(req)) {
    logger.warn('Unauthorized shutdown attempt blocked', { ip: req.ip });
    res.status(404).json({ success: false, message: 'Not found' });
    return;
  }

  logger.info('Authorized shutdown endpoint called — closing connections');
  res.status(200).json({ status: 'shutting_down', timestamp: new Date().toISOString() });

  // Close pool asynchronously so the response can flush
  closePool()
    .catch((err) => logger.warn('Error closing pool during shutdown', { error: (err as Error).message }))
    .finally(() => {
      // Allow a moment for the response to flush
      setTimeout(() => process.exit(0), 100);
    });
}

const router = Router();

router.get('/live', liveness);
router.get('/ready', readiness);
router.get('/shutdown', shutdown);

export default router;