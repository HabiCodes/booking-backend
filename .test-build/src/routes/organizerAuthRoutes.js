"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const organizerAuthController_1 = require("../controllers/organizerAuthController");
const router = (0, express_1.Router)();
router.post('/login', organizerAuthController_1.login);
router.post('/refresh', organizerAuthController_1.refresh);
exports.default = router;
