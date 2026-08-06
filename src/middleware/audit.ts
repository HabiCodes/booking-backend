/**
 * Audit middleware — logs every admin mutation to `audit_logs`.
 *
 * Usage:
 *   router.post('/events/:id/publish',
 *     adminAuthMiddleware,
 *     requirePermission('events:publish'),
 *     auditMiddleware('event.publish'),
 *     adminPublishEvent);
 *
 * `auditMiddleware('event.publish')` resolves entity_type/entity_id from req.params
 * and req.body automatically. Pass options to override:
 *   auditMiddleware('event.publish', {
 *     entityType: () => 'event',
 *     entityId: () => req.params.id,
 *     extra: (req) => ({ title: req.body.title }),
 *   });
 */

import { type Request, type Response, type NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { auditLogRepository } from '../repositories/auditLogRepository';

export interface AuditOptions {
  /** Force a specific entity_type (default: derived from first segment of action) */
  entityType?: string | ((req: Request) => string | undefined);
  /** Force a specific entity_id (default: req.params.id if numeric) */
  entityId?: number | string | ((req: Request) => number | string | undefined);
  /** Additional metadata to attach */
  extra?: (req: Request, res: Response) => Record<string, unknown>;
}

function resolveValue<T>(val: T | ((req: Request) => T) | undefined, req: Request): T | undefined {
  if (typeof val === 'function') return (val as (r: Request) => T)(req);
  return val;
}

export function auditMiddleware(
  action: string,
  options: AuditOptions = {}
) {
  return (req: AdminRequest, res: Response, next: NextFunction): void => {
    if (!res.headersSent) {
      const originalJson = res.json.bind(res);
      res.json = function (body: Record<string, unknown>) {
        // Only log successful mutations (2xx)
        const statusCode = (res as Response & { statusCode?: number }).statusCode;
        if (statusCode && statusCode >= 200 && statusCode < 300 && req.admin) {
          const entityType = resolveValue(options.entityType, req) ??
            action.split('.')[0];
          const rawId = resolveValue(options.entityId, req) ?? req.params.id;
          let entityId: number | undefined;
          if (typeof rawId === 'number') {
            entityId = rawId;
          } else if (typeof rawId === 'string' && /^\d+$/.test(rawId)) {
            entityId = parseInt(rawId, 10);
          }

          const metadata: Record<string, unknown> = {
            action,
            status: 'success',
            ...(options.extra ? options.extra(req, res) : {}),
          };

          auditLogRepository.insert({
            adminId: req.admin.id,
            action,
            entityType,
            entityId,
            metadata,
            ipAddress: (req as { ip?: string }).ip ?? req.socket.remoteAddress ?? null,
            userAgent: req.get('user-agent') ?? null,
          });
        }
        return originalJson(body);
      };
    }
    next();
  };
}
