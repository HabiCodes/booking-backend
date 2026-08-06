"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadEventImage = uploadEventImage;
exports.uploadBannerImage = uploadBannerImage;
const config_1 = require("../config");
const uploadService_1 = require("../services/uploadService");
const errorHandler_1 = require("../middleware/errorHandler");
async function uploadEventImage(req, res, next) {
    try {
        const upReq = req;
        const file = upReq.upload;
        if (!file) {
            throw new errorHandler_1.AppError('No file uploaded', 400);
        }
        const saved = await (0, uploadService_1.saveUpload)(file.buffer, 'events', config_1.config.uploads.maxEventImageBytes);
        res.status(201).json({ success: true, data: saved });
    }
    catch (err) {
        next(err);
    }
}
async function uploadBannerImage(req, res, next) {
    try {
        const upReq = req;
        const file = upReq.upload;
        if (!file) {
            throw new errorHandler_1.AppError('No file uploaded', 400);
        }
        const saved = await (0, uploadService_1.saveUpload)(file.buffer, 'banners', config_1.config.uploads.maxFileSizeBytes, {
            minWidth: config_1.config.uploads.bannerMinWidth,
            minHeight: config_1.config.uploads.bannerMinHeight,
        });
        res.status(201).json({ success: true, data: saved });
    }
    catch (err) {
        next(err);
    }
}
