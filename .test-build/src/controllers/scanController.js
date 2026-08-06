"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTicket = verifyTicket;
exports.markTicket = markTicket;
const scanService_1 = require("../services/scanService");
const errorHandler_1 = require("../middleware/errorHandler");
async function verifyTicket(req, res, next) {
    try {
        const { ticket_uuid } = req.body;
        if (!ticket_uuid)
            throw new errorHandler_1.AppError('ticket_uuid required', 400);
        const result = await scanService_1.scanService.verify(ticket_uuid);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function markTicket(req, res, next) {
    try {
        if (!req.admin)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const { ticket_uuid } = req.body;
        if (!ticket_uuid)
            throw new errorHandler_1.AppError('ticket_uuid required', 400);
        const result = await scanService_1.scanService.markCheckedIn(ticket_uuid, req.admin.id);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
