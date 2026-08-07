"use strict";
/**
 * Media controller — admin endpoints for media library and event-media binding.
 *
 * Endpoints (mounted at /api/admin/media):
 *   POST   /media               — upload a file, create media row (dedup by sha256)
 *   GET    /media               — list media
 *   GET    /media/:id           — get one media
 *   PATCH  /media/:id           — update media metadata
 *   DELETE /media/:id           — soft delete
 *   POST   /media/:id/restore   — restore soft-deleted
 *
 *   POST   /events/:eventId/media              — attach existing media to event
 *   GET    /events/:eventId/media              — list media for an event
 *   PATCH  /events/:eventId/media/:mediaId     — update event-media binding (role, order, primary)
 *   DELETE /events/:eventId/media/:mediaId     — detach
 *   POST   /events/:eventId/media/reorder      — bulk reorder
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadMedia = uploadMedia;
exports.listMedia = listMedia;
exports.getMedia = getMedia;
exports.updateMedia = updateMedia;
exports.deleteMedia = deleteMedia;
exports.restoreMedia = restoreMedia;
exports.attachEventMedia = attachEventMedia;
exports.listEventMedia = listEventMedia;
exports.updateEventMedia = updateEventMedia;
exports.detachEventMedia = detachEventMedia;
exports.reorderEventMedia = reorderEventMedia;
const errorHandler_1 = require("../middleware/errorHandler");
const mediaService_1 = require("../services/mediaService");
// ── Media CRUD ────────────────────────────────────────────────────────────────
async function uploadMedia(req, res, next) {
    try {
        // The file is delivered as a base64 string in a JSON body (jsonUploadMiddleware)
        const body = req.body;
        if (!body?.data || !body.mime_type || !body.filename) {
            throw new errorHandler_1.AppError('Missing required fields: data (base64), mime_type, filename', 400);
        }
        const buf = Buffer.from(body.data, 'base64');
        if (buf.length === 0) {
            throw new errorHandler_1.AppError('Empty file content', 400);
        }
        const result = await mediaService_1.mediaService.processUpload(buf, {
            mimeType: body.mime_type,
            fileName: body.filename,
            subdir: body.subdir ?? 'events',
            width: body.width ?? null,
            height: body.height ?? null,
            durationSeconds: body.duration_seconds ?? null,
            videoProvider: body.video_provider ?? null,
            blurHash: body.blur_hash ?? null,
            dominantColor: body.dominant_color ?? null,
            altText: body.alt_text ?? null,
            isPublic: body.is_public ?? true,
            uploadedBy: req.admin?.id ?? null,
        });
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function listMedia(req, res, next) {
    try {
        const query = {
            page: req.query.page ? Number(req.query.page) : undefined,
            pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
            search: req.query.search,
            mime_type: req.query.mime_type,
            is_public: req.query.is_public === undefined ? undefined : req.query.is_public === 'true',
            include_deleted: req.query.include_deleted === 'true',
            fromDate: req.query.fromDate,
            toDate: req.query.toDate,
        };
        const result = await mediaService_1.mediaService.listMedia(query);
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
async function getMedia(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id))
            throw new errorHandler_1.AppError('Invalid media id', 400);
        const result = await mediaService_1.mediaService.getMedia(id);
        if (!result)
            throw new errorHandler_1.AppError('Media not found', 404);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function updateMedia(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id))
            throw new errorHandler_1.AppError('Invalid media id', 400);
        const input = {};
        if (req.body.file_name !== undefined)
            input.file_name = req.body.file_name;
        if (req.body.alt_text !== undefined)
            input.alt_text = req.body.alt_text;
        if (req.body.is_public !== undefined)
            input.is_public = Boolean(req.body.is_public);
        if (req.body.blur_hash !== undefined)
            input.blur_hash = req.body.blur_hash;
        if (req.body.dominant_color !== undefined)
            input.dominant_color = req.body.dominant_color;
        if (req.body.width !== undefined)
            input.width = req.body.width;
        if (req.body.height !== undefined)
            input.height = req.body.height;
        if (req.body.duration_seconds !== undefined)
            input.duration_seconds = req.body.duration_seconds;
        if (req.body.public_url !== undefined)
            input.public_url = req.body.public_url;
        const result = await mediaService_1.mediaService.updateMedia(id, input);
        if (!result)
            throw new errorHandler_1.AppError('Media not found', 404);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function deleteMedia(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id))
            throw new errorHandler_1.AppError('Invalid media id', 400);
        const ok = await mediaService_1.mediaService.deleteMedia(id, false);
        if (!ok)
            throw new errorHandler_1.AppError('Media not found', 404);
        res.json({ success: true, message: 'Media deleted' });
    }
    catch (err) {
        next(err);
    }
}
async function restoreMedia(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id))
            throw new errorHandler_1.AppError('Invalid media id', 400);
        const ok = await mediaService_1.mediaService.restoreMedia(id);
        if (!ok)
            throw new errorHandler_1.AppError('Media not found or not deleted', 404);
        res.json({ success: true, message: 'Media restored' });
    }
    catch (err) {
        next(err);
    }
}
// ── Event-Media ───────────────────────────────────────────────────────────────
async function attachEventMedia(req, res, next) {
    try {
        const eventId = parseInt(req.params.eventId, 10);
        if (Number.isNaN(eventId))
            throw new errorHandler_1.AppError('Invalid event id', 400);
        const body = req.body;
        if (!body.media_id)
            throw new errorHandler_1.AppError('media_id is required', 400);
        if (!body.media_type)
            throw new errorHandler_1.AppError('media_type is required', 400);
        const input = {
            media_id: body.media_id,
            media_type: body.media_type,
            display_order: body.display_order ?? 0,
            is_primary: body.is_primary ?? false,
        };
        const result = await mediaService_1.mediaService.attachToEvent(eventId, input, { makePrimary: input.is_primary });
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function listEventMedia(req, res, next) {
    try {
        const eventId = parseInt(req.params.eventId, 10);
        if (Number.isNaN(eventId))
            throw new errorHandler_1.AppError('Invalid event id', 400);
        const mediaType = req.query.media_type;
        const includeDetails = req.query.with_details === 'true';
        if (includeDetails) {
            const result = await mediaService_1.mediaService.getEventMediaWithDetails(eventId, mediaType);
            res.json({ success: true, data: result });
        }
        else {
            const result = await mediaService_1.mediaService.getEventMedia(eventId, mediaType);
            res.json({ success: true, data: result });
        }
    }
    catch (err) {
        next(err);
    }
}
async function updateEventMedia(req, res, next) {
    try {
        const eventMediaId = parseInt(req.params.eventMediaId, 10);
        if (Number.isNaN(eventMediaId))
            throw new errorHandler_1.AppError('Invalid event_media id', 400);
        const input = {};
        if (req.body.media_type !== undefined)
            input.media_type = req.body.media_type;
        if (req.body.display_order !== undefined)
            input.display_order = Number(req.body.display_order);
        if (req.body.status !== undefined)
            input.status = req.body.status;
        if (req.body.is_primary !== undefined)
            input.is_primary = Boolean(req.body.is_primary);
        const result = await mediaService_1.mediaService.updateEventMedia(eventMediaId, input);
        if (!result)
            throw new errorHandler_1.AppError('Event media binding not found', 404);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function detachEventMedia(req, res, next) {
    try {
        const eventId = parseInt(req.params.eventId, 10);
        const mediaId = parseInt(req.params.mediaId, 10);
        if (Number.isNaN(eventId) || Number.isNaN(mediaId)) {
            throw new errorHandler_1.AppError('Invalid event_id or media_id', 400);
        }
        const ok = await mediaService_1.mediaService.detachFromEvent(eventId, mediaId);
        if (!ok)
            throw new errorHandler_1.AppError('Media is not attached to this event', 404);
        res.json({ success: true, message: 'Media detached from event' });
    }
    catch (err) {
        next(err);
    }
}
async function reorderEventMedia(req, res, next) {
    try {
        const eventId = parseInt(req.params.eventId, 10);
        if (Number.isNaN(eventId))
            throw new errorHandler_1.AppError('Invalid event id', 400);
        const body = req.body;
        if (!Array.isArray(body.media_ids)) {
            throw new errorHandler_1.AppError('media_ids must be an array of numbers', 400);
        }
        await mediaService_1.mediaService.reorderEventMedia(eventId, body.media_ids);
        res.json({ success: true, message: 'Reordered' });
    }
    catch (err) {
        next(err);
    }
}
