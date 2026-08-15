"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const organizerAuthController_1 = require("../controllers/organizerAuthController");
const rateLimiter_1 = require("../middleware/rateLimiter");
const router = (0, express_1.Router)();
// Login and refresh share the auth limiter (stricter than global)
router.post('/login', rateLimiter_1.authRateLimiter, organizerAuthController_1.login);
router.post('/refresh', rateLimiter_1.authRateLimiter, organizerAuthController_1.refresh);
// Setup-password is a one-time token redemption — tighten further to prevent brute-force
router.post('/setup-password', rateLimiter_1.authRateLimiter, organizerAuthController_1.setupPassword);
exports.default = router;
