"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listBanners = listBanners;
exports.getBanner = getBanner;
exports.activateBanner = activateBanner;
exports.deactivateBanner = deactivateBanner;
exports.updateBanner = updateBanner;
exports.deleteBanner = deleteBanner;
exports.createBannerFromUpload = createBannerFromUpload;
exports.getActiveTicketAd = getActiveTicketAd;
const config_1 = require("../config");
const bannerService_1 = require("../services/bannerService");
const uploadService_1 = require("../services/uploadService");
const errorHandler_1 = require("../middleware/errorHandler");
async function listBanners(req, res, next) {
    try {
        const placement = req.query.placement ?? undefined;
        const isActive = req.query.is_active !== undefined
            ? req.query.is_active === 'true'
            : undefined;
        const page = parseInt(req.query.page ?? '1', 10) || 1;
        const pageSize = parseInt(req.query.page_size ?? '20', 10) || 20;
        const result = await bannerService_1.bannerService.listBanners({
            placement: placement,
            isActive,
            page,
            pageSize,
        });
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function getBanner(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) {
            throw new errorHandler_1.AppError('Invalid banner ID', 400);
        }
        const banner = await bannerService_1.bannerService.getBanner(id);
        if (!banner) {
            throw new errorHandler_1.AppError('Banner not found', 404);
        }
        res.json({ success: true, data: banner });
    }
    catch (err) {
        next(err);
    }
}
async function activateBanner(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) {
            throw new errorHandler_1.AppError('Invalid banner ID', 400);
        }
        const banner = await bannerService_1.bannerService.activateBanner(id);
        if (!banner) {
            throw new errorHandler_1.AppError('Banner not found', 404);
        }
        res.json({ success: true, data: banner, message: 'Banner activated' });
    }
    catch (err) {
        next(err);
    }
}
async function deactivateBanner(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) {
            throw new errorHandler_1.AppError('Invalid banner ID', 400);
        }
        const banner = await bannerService_1.bannerService.deactivateBanner(id);
        if (!banner) {
            throw new errorHandler_1.AppError('Banner not found or already deactivated', 404);
        }
        res.json({ success: true, data: banner, message: 'Banner deactivated' });
    }
    catch (err) {
        next(err);
    }
}
async function updateBanner(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) {
            throw new errorHandler_1.AppError('Invalid banner ID', 400);
        }
        const { alt_text, link_url, priority } = req.body ?? {};
        const banner = await bannerService_1.bannerService.updateBanner(id, {
            alt_text,
            link_url,
            priority,
        });
        if (!banner) {
            throw new errorHandler_1.AppError('Banner not found', 404);
        }
        res.json({ success: true, data: banner });
    }
    catch (err) {
        next(err);
    }
}
async function deleteBanner(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (Number.isNaN(id)) {
            throw new errorHandler_1.AppError('Invalid banner ID', 400);
        }
        const deleted = await bannerService_1.bannerService.softDeleteBanner(id);
        if (!deleted) {
            throw new errorHandler_1.AppError('Banner not found', 404);
        }
        res.json({ success: true, message: 'Banner deleted' });
    }
    catch (err) {
        next(err);
    }
}
async function createBannerFromUpload(req, res, next) {
    try {
        if (!req.admin) {
            throw new errorHandler_1.AppError('Unauthorized', 401);
        }
        const upReq = req;
        const file = upReq.upload;
        if (!file) {
            throw new errorHandler_1.AppError('No file uploaded', 400);
        }
        const saved = await (0, uploadService_1.saveUpload)(file.buffer, 'banners', config_1.config.uploads.maxFileSizeBytes, {
            minWidth: config_1.config.uploads.bannerMinWidth,
            minHeight: config_1.config.uploads.bannerMinHeight,
        });
        const placementRaw = req.body?.placement ?? 'ticket_advertisement';
        const placement = placementRaw;
        if (!['ticket_advertisement', 'homepage_hero', 'event_thumbnail'].includes(placement)) {
            throw new errorHandler_1.AppError(`Invalid placement: ${placement}`, 400);
        }
        const result = await bannerService_1.bannerService.createBanner({
            imageUrl: saved.url,
            mimeType: saved.mimeType,
            fileSizeBytes: saved.sizeBytes,
            width: saved.width,
            height: saved.height,
            uploadedBy: req.admin.id,
            placement,
            altText: req.body?.alt_text ?? null,
            linkUrl: req.body?.link_url ?? null,
            priority: typeof req.body?.priority === 'number' ? req.body.priority : 0,
        });
        res.status(201).json({ success: true, data: result.banner });
    }
    catch (err) {
        next(err);
    }
}
async function getActiveTicketAd(req, res, next) {
    try {
        const banner = await bannerService_1.bannerService.getActiveTicketAd();
        res.json({ success: true, data: banner });
    }
    catch (err) {
        next(err);
    }
}
