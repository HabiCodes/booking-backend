"use strict";
/**
 * Event Lifecycle Admin Controller
 *
 * Endpoints:
 *   POST /api/admin/events/:id/submit-for-review
 *   POST /api/admin/events/:id/approve
 *   POST /api/admin/events/:id/reject
 *   POST /api/admin/events/:id/publish
 *   POST /api/admin/events/:id/unpublish
 *   POST /api/admin/events/:id/hide
 *   POST /api/admin/events/:id/show
 *   POST /api/admin/events/:id/archive
 *   POST /api/admin/events/:id/restore
 *   GET  /api/admin/events/:id/history
 *   GET  /api/admin/events/pending-review
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitForReview = submitForReview;
exports.approveEvent = approveEvent;
exports.rejectEvent = rejectEvent;
exports.publishEvent = publishEvent;
exports.unpublishEvent = unpublishEvent;
exports.hideEvent = hideEvent;
exports.showEvent = showEvent;
exports.archiveEvent = archiveEvent;
exports.restoreEvent = restoreEvent;
exports.cancelEvent = cancelEvent;
exports.getEventHistory = getEventHistory;
exports.listPendingReview = listPendingReview;
const eventLifecycleService_1 = require("../services/eventLifecycleService");
const eventRepository_1 = require("../repositories/eventRepository");
function eventIdParam(req) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
        throw { statusCode: 400, message: 'Invalid event ID' };
    }
    return id;
}
function actor(req) {
    return {
        adminId: req.admin?.id ?? null,
        ip: req.ip,
        userAgent: req.get('user-agent') ?? null,
    };
}
// ── Transition handlers ───────────────────────────────────────────────────────
// Each handler delegates to the service, which validates the state machine,
// applies the transition + side-effects in a single transaction, and appends
// the history row.
async function submitForReview(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        const { event } = await eventLifecycleService_1.eventLifecycleService.submitForReview(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function approveEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const { event } = await eventLifecycleService_1.eventLifecycleService.approveEvent(eventId, actor(req));
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function rejectEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        if (!body.reason?.trim()) {
            throw { statusCode: 400, message: 'rejection reason is required' };
        }
        const { event } = await eventLifecycleService_1.eventLifecycleService.rejectEvent(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function publishEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const { event } = await eventLifecycleService_1.eventLifecycleService.publishEvent(eventId, actor(req));
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function unpublishEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const { event } = await eventLifecycleService_1.eventLifecycleService.unpublishEvent(eventId, actor(req));
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function hideEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        const { event } = await eventLifecycleService_1.eventLifecycleService.hideEvent(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function showEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const { event } = await eventLifecycleService_1.eventLifecycleService.showEvent(eventId, actor(req));
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function archiveEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        const { event } = await eventLifecycleService_1.eventLifecycleService.archiveEvent(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function restoreEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        const { event } = await eventLifecycleService_1.eventLifecycleService.restoreEvent(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function cancelEvent(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const body = (req.body ?? {});
        const { event } = await eventLifecycleService_1.eventLifecycleService.cancelEvent(eventId, actor(req), body.reason);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
// ── History ───────────────────────────────────────────────────────────────────
async function getEventHistory(req, res, next) {
    try {
        const eventId = eventIdParam(req);
        const history = await eventLifecycleService_1.eventLifecycleService.getHistory(eventId);
        res.json({ success: true, data: history });
    }
    catch (err) {
        next(err);
    }
}
// ── Review queue ──────────────────────────────────────────────────────────────
async function listPendingReview(req, res, next) {
    try {
        const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 50;
        const page = req.query.page ? Number(req.query.page) : 1;
        const result = await eventRepository_1.eventRepository.listPendingReview(pageSize, page);
        res.json({
            success: true,
            data: result.items,
            pagination: {
                total: result.total,
                page: result.page,
                pageSize: result.pageSize,
                totalPages: result.totalPages,
            },
        });
    }
    catch (err) {
        next(err);
    }
}
