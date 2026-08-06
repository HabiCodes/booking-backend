"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_2 = __importDefault(require("express"));
const bannerController_1 = require("../controllers/bannerController");
const adminAuth_1 = require("../middleware/adminAuth");
const permissions_1 = require("../middleware/permissions");
const audit_1 = require("../middleware/audit");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
router.use(adminAuth_1.adminAuthMiddleware);
// Read (banners:read or analytics:read for ticket ads)
router.get('/', (0, permissions_1.requirePermission)('banners:read'), (req, res, next) => (0, bannerController_1.listBanners)(req, res, next));
router.get('/active-ticket-ad', (req, res, next) => (0, bannerController_1.getActiveTicketAd)(req, res, next));
router.get('/:id', (0, permissions_1.requirePermission)('banners:read'), (req, res, next) => (0, bannerController_1.getBanner)(req, res, next));
// Create
router.post('/', (0, permissions_1.requirePermission)('banners:write'), express_2.default.json({ limit: '15mb' }), upload_1.jsonUploadMiddleware, (0, audit_1.auditMiddleware)('banner.create'), (req, res, next) => (0, bannerController_1.createBannerFromUpload)(req, res, next));
// Update
router.patch('/:id', (0, permissions_1.requirePermission)('banners:write'), express_2.default.json({ limit: '64kb' }), (0, audit_1.auditMiddleware)('banner.update'), (req, res, next) => (0, bannerController_1.updateBanner)(req, res, next));
// Delete
router.delete('/:id', (0, permissions_1.requirePermission)('banners:delete'), (0, audit_1.auditMiddleware)('banner.delete'), (req, res, next) => (0, bannerController_1.deleteBanner)(req, res, next));
// Activation toggle
router.put('/:id/activate', (0, permissions_1.requirePermission)('banners:write'), (0, audit_1.auditMiddleware)('banner.activate'), (req, res, next) => (0, bannerController_1.activateBanner)(req, res, next));
router.put('/:id/deactivate', (0, permissions_1.requirePermission)('banners:write'), (0, audit_1.auditMiddleware)('banner.deactivate'), (req, res, next) => (0, bannerController_1.deactivateBanner)(req, res, next));
exports.default = router;
