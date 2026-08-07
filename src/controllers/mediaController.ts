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

import { Request, Response, NextFunction } from 'express';
import { AdminRequest } from '../middleware/adminAuth';
import { AppError } from '../middleware/errorHandler';
import { mediaService } from '../services/mediaService';
import type { MediaListQuery, MediaUpdateInput, EventMediaCreateInput, EventMediaUpdateInput, MediaType, MediaStatus } from '../types';

// ── Media CRUD ────────────────────────────────────────────────────────────────

export async function uploadMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // The file is delivered as a base64 string in a JSON body (jsonUploadMiddleware)
    const body = req.body as {
      data?: string;          // base64
      filename?: string;
      mime_type?: string;
      subdir?: 'events' | 'banners' | 'tickets';
      width?: number | null;
      height?: number | null;
      duration_seconds?: number | null;
      video_provider?: string | null;
      blur_hash?: string | null;
      dominant_color?: string | null;
      alt_text?: string | null;
      is_public?: boolean;
    };

    if (!body?.data || !body.mime_type || !body.filename) {
      throw new AppError('Missing required fields: data (base64), mime_type, filename', 400);
    }

    const buf = Buffer.from(body.data, 'base64');
    if (buf.length === 0) {
      throw new AppError('Empty file content', 400);
    }

    const result = await mediaService.processUpload(buf, {
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
  } catch (err) {
    next(err);
  }
}

export async function listMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const query: MediaListQuery = {
      page: req.query.page ? Number(req.query.page) : undefined,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      search: req.query.search as string | undefined,
      mime_type: req.query.mime_type as string | undefined,
      is_public: req.query.is_public === undefined ? undefined : req.query.is_public === 'true',
      include_deleted: req.query.include_deleted === 'true',
      fromDate: req.query.fromDate as string | undefined,
      toDate: req.query.toDate as string | undefined,
    };
    const result = await mediaService.listMedia(query);
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
  } catch (err) {
    next(err);
  }
}

export async function getMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new AppError('Invalid media id', 400);
    const result = await mediaService.getMedia(id);
    if (!result) throw new AppError('Media not found', 404);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new AppError('Invalid media id', 400);

    const input: MediaUpdateInput = {};
    if (req.body.file_name !== undefined) input.file_name = req.body.file_name;
    if (req.body.alt_text !== undefined) input.alt_text = req.body.alt_text;
    if (req.body.is_public !== undefined) input.is_public = Boolean(req.body.is_public);
    if (req.body.blur_hash !== undefined) input.blur_hash = req.body.blur_hash;
    if (req.body.dominant_color !== undefined) input.dominant_color = req.body.dominant_color;
    if (req.body.width !== undefined) input.width = req.body.width;
    if (req.body.height !== undefined) input.height = req.body.height;
    if (req.body.duration_seconds !== undefined) input.duration_seconds = req.body.duration_seconds;
    if (req.body.public_url !== undefined) input.public_url = req.body.public_url;

    const result = await mediaService.updateMedia(id, input);
    if (!result) throw new AppError('Media not found', 404);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function deleteMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new AppError('Invalid media id', 400);
    const ok = await mediaService.deleteMedia(id, false);
    if (!ok) throw new AppError('Media not found', 404);
    res.json({ success: true, message: 'Media deleted' });
  } catch (err) {
    next(err);
  }
}

export async function restoreMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) throw new AppError('Invalid media id', 400);
    const ok = await mediaService.restoreMedia(id);
    if (!ok) throw new AppError('Media not found or not deleted', 404);
    res.json({ success: true, message: 'Media restored' });
  } catch (err) {
    next(err);
  }
}

// ── Event-Media ───────────────────────────────────────────────────────────────

export async function attachEventMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    if (Number.isNaN(eventId)) throw new AppError('Invalid event id', 400);

    const body = req.body as { media_id?: number; media_type?: MediaType; display_order?: number; is_primary?: boolean };
    if (!body.media_id) throw new AppError('media_id is required', 400);
    if (!body.media_type) throw new AppError('media_type is required', 400);

    const input: EventMediaCreateInput = {
      media_id: body.media_id,
      media_type: body.media_type,
      display_order: body.display_order ?? 0,
      is_primary: body.is_primary ?? false,
    };

    const result = await mediaService.attachToEvent(eventId, input, { makePrimary: input.is_primary });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function listEventMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    if (Number.isNaN(eventId)) throw new AppError('Invalid event id', 400);

    const mediaType = req.query.media_type as MediaType | undefined;
    const includeDetails = req.query.with_details === 'true';

    if (includeDetails) {
      const result = await mediaService.getEventMediaWithDetails(eventId, mediaType);
      res.json({ success: true, data: result });
    } else {
      const result = await mediaService.getEventMedia(eventId, mediaType);
      res.json({ success: true, data: result });
    }
  } catch (err) {
    next(err);
  }
}

export async function updateEventMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventMediaId = parseInt(req.params.eventMediaId, 10);
    if (Number.isNaN(eventMediaId)) throw new AppError('Invalid event_media id', 400);

    const input: EventMediaUpdateInput = {};
    if (req.body.media_type !== undefined) input.media_type = req.body.media_type;
    if (req.body.display_order !== undefined) input.display_order = Number(req.body.display_order);
    if (req.body.status !== undefined) input.status = req.body.status as MediaStatus;
    if (req.body.is_primary !== undefined) input.is_primary = Boolean(req.body.is_primary);

    const result = await mediaService.updateEventMedia(eventMediaId, input);
    if (!result) throw new AppError('Event media binding not found', 404);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function detachEventMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    const mediaId = parseInt(req.params.mediaId, 10);
    if (Number.isNaN(eventId) || Number.isNaN(mediaId)) {
      throw new AppError('Invalid event_id or media_id', 400);
    }
    const ok = await mediaService.detachFromEvent(eventId, mediaId);
    if (!ok) throw new AppError('Media is not attached to this event', 404);
    res.json({ success: true, message: 'Media detached from event' });
  } catch (err) {
    next(err);
  }
}

export async function reorderEventMedia(req: AdminRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    if (Number.isNaN(eventId)) throw new AppError('Invalid event id', 400);

    const body = req.body as { media_ids?: number[] };
    if (!Array.isArray(body.media_ids)) {
      throw new AppError('media_ids must be an array of numbers', 400);
    }

    await mediaService.reorderEventMedia(eventId, body.media_ids);
    res.json({ success: true, message: 'Reordered' });
  } catch (err) {
    next(err);
  }
}