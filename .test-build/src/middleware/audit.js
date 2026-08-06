"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditMiddleware = auditMiddleware;
const auditLogRepository_1 = require("../repositories/auditLogRepository");
function resolveValue(val, req) {
    if (typeof val === 'function')
        return val(req);
    return val;
}
function auditMiddleware(action, options = {}) {
    return (req, res, next) => {
        if (!res.headersSent) {
            const originalJson = res.json.bind(res);
            res.json = function (body) {
                // Only log successful mutations (2xx)
                const statusCode = res.statusCode;
                if (statusCode && statusCode >= 200 && statusCode < 300 && req.admin) {
                    const entityType = resolveValue(options.entityType, req) ??
                        action.split('.')[0];
                    const rawId = resolveValue(options.entityId, req) ?? req.params.id;
                    let entityId;
                    if (typeof rawId === 'number') {
                        entityId = rawId;
                    }
                    else if (typeof rawId === 'string' && /^\d+$/.test(rawId)) {
                        entityId = parseInt(rawId, 10);
                    }
                    const metadata = {
                        action,
                        status: 'success',
                        ...(options.extra ? options.extra(req, res) : {}),
                    };
                    auditLogRepository_1.auditLogRepository.insert({
                        adminId: req.admin.id,
                        action,
                        entityType,
                        entityId,
                        metadata,
                        ipAddress: req.ip ?? req.socket.remoteAddress ?? null,
                        userAgent: req.get('user-agent') ?? null,
                    });
                }
                return originalJson(body);
            };
        }
        next();
    };
}
