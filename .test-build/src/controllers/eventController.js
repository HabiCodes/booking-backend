"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listEvents = listEvents;
exports.getEvent = getEvent;
exports.getStats = getStats;
exports.getFeaturedEvents = getFeaturedEvents;
exports.getCategories = getCategories;
exports.getCities = getCities;
exports.adminListEvents = adminListEvents;
exports.adminCreateEvent = adminCreateEvent;
exports.adminUpdateEvent = adminUpdateEvent;
exports.adminDeleteEvent = adminDeleteEvent;
exports.adminRestoreEvent = adminRestoreEvent;
exports.adminPublishEvent = adminPublishEvent;
exports.adminHideEvent = adminHideEvent;
exports.adminCancelEvent = adminCancelEvent;
exports.adminSetFeatured = adminSetFeatured;
const eventService_1 = require("../services/eventService");
// ── Public endpoints ────────────────────────────────────────────────────────
async function listEvents(req, res, next) {
    try {
        const query = {
            page: req.query.page ? Number(req.query.page) : undefined,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
            search: req.query.search,
            category: req.query.category,
            city: req.query.city,
            fromDate: req.query.fromDate,
            toDate: req.query.toDate,
            sortBy: req.query.sortBy,
            sortOrder: req.query.sortOrder,
            featured: req.query.featured === 'true' ? true : undefined,
        };
        const result = await eventService_1.eventService.listPublicEvents(query);
        // Public cache: 60s browser, 5min CDN/edge. Details will go stale faster
        // via the booking socket broadcast, so a short TTL is fine.
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
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
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function getEvent(req, res, next) {
    try {
        const eventId = parseInt(req.params.id, 10);
        if (!Number.isFinite(eventId)) {
            return res.status(400).json({ success: false, message: 'Invalid event ID' });
        }
        const detail = await eventService_1.eventService.getPublicEventDetail(eventId);
        if (!detail)
            return res.status(404).json({ success: false, message: 'Event not found' });
        res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=120');
        return res.json({
            success: true,
            data: {
                ...detail.event,
                stats: detail.stats,
                related: detail.related,
            },
        });
    }
    catch (err) {
        return next(err);
    }
}
async function getStats(req, res, next) {
    try {
        const eventId = parseInt(req.params.id, 10);
        const stats = await eventService_1.eventService.getBookingStats(eventId);
        // Live capacity — don't cache aggressively
        res.setHeader('Cache-Control', 'public, max-age=5');
        res.json({ success: true, data: stats });
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function getFeaturedEvents(req, res, next) {
    try {
        const limit = req.query.limit ? Number(req.query.limit) : 5;
        const items = await eventService_1.eventService.listFeaturedEvents(limit);
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
        res.json({ success: true, data: items });
        return;
    }
    catch (err) {
        return next(err);
    }
}
/**
 * Public — list distinct categories used by published public events.
 * Used by the discovery page filter dropdown.
 */
async function getCategories(_req, res, next) {
    try {
        const items = await eventService_1.eventService.listPublicCategories();
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
        res.json({ success: true, data: items });
        return;
    }
    catch (err) {
        return next(err);
    }
}
/**
 * Public — list distinct cities hosting published public events.
 */
async function getCities(_req, res, next) {
    try {
        const items = await eventService_1.eventService.listPublicCities();
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');
        res.json({ success: true, data: items });
        return;
    }
    catch (err) {
        return next(err);
    }
}
// ── Admin endpoints (CRUD) ──────────────────────────────────────────────────
async function adminListEvents(req, res, next) {
    try {
        const query = {
            page: req.query.page ? Number(req.query.page) : undefined,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
            search: req.query.search,
            category: req.query.category,
            city: req.query.city,
            status: req.query.status,
            include_deleted: req.query.include_deleted === 'true',
        };
        const result = await eventService_1.eventService.listAllEvents(query);
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
        return next(err);
    }
}
async function adminCreateEvent(req, res, next) {
    try {
        const id = await eventService_1.eventService.createEvent(req.body);
        const event = await eventService_1.eventService.getEventById(id);
        res.status(201).json({ success: true, data: event });
    }
    catch (err) {
        return next(err);
    }
}
async function adminUpdateEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const event = await eventService_1.eventService.updateEvent(id, req.body);
        res.json({ success: true, data: event });
    }
    catch (err) {
        return next(err);
    }
}
async function adminDeleteEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await eventService_1.eventService.deleteEvent(id);
        res.json({ success: true, message: 'Event deleted' });
    }
    catch (err) {
        return next(err);
    }
}
async function adminRestoreEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await eventService_1.eventService.restoreEvent(id);
        res.json({ success: true, message: 'Event restored' });
    }
    catch (err) {
        return next(err);
    }
}
async function adminPublishEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const result = await eventService_1.eventService.publishEvent(id);
        res.json({ success: true, data: result.event });
    }
    catch (err) {
        return next(err);
    }
}
async function adminHideEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await eventService_1.eventService.hideEvent(id);
        res.json({ success: true, message: 'Event hidden' });
    }
    catch (err) {
        return next(err);
    }
}
async function adminCancelEvent(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await eventService_1.eventService.cancelEvent(id);
        res.json({ success: true, message: 'Event cancelled' });
    }
    catch (err) {
        return next(err);
    }
}
async function adminSetFeatured(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const { is_featured } = req.body;
        await eventService_1.eventService.setFeatured(id, Boolean(is_featured));
        res.json({ success: true, message: 'Featured flag updated' });
    }
    catch (err) {
        return next(err);
    }
}
