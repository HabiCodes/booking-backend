"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_2 = __importDefault(require("express"));
const uploadController_1 = require("../controllers/uploadController");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
router.use(adminAuth_1.adminAuthMiddleware);
// Event images (banner, thumbnail, gallery)
router.post('/event', (0, permissions_1.requirePermission)('uploads:write'), express_2.default.json({ limit: '15mb' }), upload_1.jsonUploadMiddleware, (0, audit_1.auditMiddleware)('upload.event', {
    entityType: 'upload',
    extra: (req) => ({
        filename: req.body?.filename ?? null,
        category: req.body?.category ?? null,
    }),
}), (req, res, next) => (0, uploadController_1.uploadEventImage)(req, res, next));
// Banner images
router.post('/banner', (0, permissions_1.requirePermission)('uploads:write'), express_2.default.json({ limit: '15mb' }), upload_1.jsonUploadMiddleware, (0, audit_1.auditMiddleware)('upload.banner', {
    entityType: 'upload',
    extra: (req) => ({
        filename: req.body?.filename ?? null,
        scope: req.body?.scope ?? null,
    }),
}), (req, res, next) => (0, uploadController_1.uploadBannerImage)(req, res, next));
exports.default = router;
