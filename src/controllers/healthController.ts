import { Router, Response } from 'express';
import { getPool, closePool } from '../db/pool';
import { logger } from '../utils/logger';

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

export function liveness(_req: unknown, res: Response): void {
  respond(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }, 200);
}

// ── Readiness: all subsystems reachable ─────────────────────────────────────

export async function readiness(_req: unknown, res: Response): Promise<void> {
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

export async function shutdown(_req: unknown, res: Response): Promise<void> {
  logger.info('Shutdown endpoint called — closing connections');
  try {
    await closePool();
  } catch (err) {
    logger.warn('Error closing pool during shutdown', { error: (err as Error).message });
  }
  res.status(200).json({ status: 'shutting_down', timestamp: new Date().toISOString() });
  process.exit(0);
}

const router = Router();

router.get('/live', liveness);
router.get('/ready', readiness);
router.get('/shutdown', shutdown);

export default router;