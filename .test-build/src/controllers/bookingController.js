"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBooking = createBooking;
exports.cancelBooking = cancelBooking;
exports.getMyBookings = getMyBookings;
exports.getBookingPdf = getBookingPdf;
exports.getBookingDetails = getBookingDetails;
const bookingService_1 = require("../services/bookingService");
const eventRepository_1 = require("../repositories/eventRepository");
const bannerRepository_1 = require("../repositories/bannerRepository");
const config_1 = require("../config");
const errorHandler_1 = require("../middleware/errorHandler");
const pdfService_1 = require("../services/pdfService");
const validator_1 = require("../middleware/validator");
const sockets_1 = require("../sockets");
async function createBooking(req, res, next) {
    try {
        if (!req.user)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const { event_id, attendees } = req.body;
        if (event_id === undefined || event_id === null) {
            throw new errorHandler_1.AppError('event_id is required', 400);
        }
        if (!Array.isArray(attendees) || attendees.length === 0) {
            throw new errorHandler_1.AppError('attendees array is required', 400);
        }
        for (const att of attendees) {
            if (!att.full_name || !att.phone) {
                throw new errorHandler_1.AppError('Each attendee requires full_name and phone', 400);
            }
            if (!(0, validator_1.validatePhone)(att.phone)) {
                throw new errorHandler_1.AppError(`Invalid phone number: ${att.phone}`, 400);
            }
            if (att.age !== undefined && att.age !== null && !(0, validator_1.validateAge)(String(att.age))) {
                throw new errorHandler_1.AppError('Invalid age', 400);
            }
            if (att.gender !== undefined && att.gender !== null && !(0, validator_1.validateGender)(att.gender)) {
                throw new errorHandler_1.AppError('Invalid gender', 400);
            }
        }
        const parsedEventId = Number(event_id);
        if (!Number.isFinite(parsedEventId)) {
            throw new errorHandler_1.AppError('Invalid event_id', 400);
        }
        const result = await bookingService_1.bookingService.createBooking(req.user.id, parsedEventId, attendees);
        const stats = await eventRepository_1.eventRepository.getBookingStats(parsedEventId);
        (0, sockets_1.broadcastBookingCount)(parsedEventId, stats.bookedCount, stats.capacity);
        (0, sockets_1.broadcastNewBooking)({
            bookingId: result.bookingId,
            user: { email: req.user.email },
            eventId: parsedEventId,
            ticketCount: attendees.length,
        });
        res.status(201).json({
            success: true,
            data: {
                bookingId: result.bookingId,
                ticketCount: attendees.length,
                tickets: result.tickets.map((t) => ({
                    ticketUuid: t.ticket_uuid,
                    attendeeName: t.attendee_name,
                    attendeePhone: t.attendee_phone,
                    signature: t.signature,
                })),
            },
        });
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function cancelBooking(req, res, next) {
    try {
        if (!req.user)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const bookingId = parseInt(req.params.id, 10);
        if (!Number.isFinite(bookingId)) {
            throw new errorHandler_1.AppError('Invalid booking id', 400);
        }
        const { reason } = req.body;
        const result = await bookingService_1.bookingService.cancelBooking(bookingId, req.user.id, reason);
        res.json({
            success: true,
            data: result,
        });
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function getMyBookings(req, res, next) {
    try {
        if (!req.user)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const bookings = await bookingService_1.bookingService.getMyBookings(req.user.id);
        res.json({ success: true, data: bookings });
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function getBookingPdf(req, res, next) {
    try {
        if (!req.user)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const bookingId = parseInt(req.params.id, 10);
        if (!Number.isFinite(bookingId)) {
            throw new errorHandler_1.AppError('Invalid booking id', 400);
        }
        const { booking, tickets } = await bookingService_1.bookingService.getBooking(bookingId, req.user.id);
        const event = await eventRepository_1.eventRepository.getEventById(booking.event_id);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        // Fetch the active ticket advertisement banner (best-effort)
        const banner = await bannerRepository_1.bannerRepository.getActiveBannerByPlacement('ticket_advertisement');
        let bannerImage = null;
        if (banner) {
            const fs = await Promise.resolve().then(() => __importStar(require('fs')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const baseDir = path.resolve(config_1.config.uploads.baseDir);
            const localPath = path.join(baseDir, banner.image_url.replace(/^\/uploads\//, ''));
            if (fs.existsSync(localPath)) {
                bannerImage = fs.readFileSync(localPath);
            }
        }
        const pdfBuffer = await (0, pdfService_1.generateBookingPdf)({ event, tickets, bannerImage });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="tickets-${bookingId}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length.toString());
        res.end(pdfBuffer);
        return;
    }
    catch (err) {
        return next(err);
    }
}
async function getBookingDetails(req, res, next) {
    try {
        if (!req.user)
            throw new errorHandler_1.AppError('Unauthorized', 401);
        const bookingId = parseInt(req.params.id, 10);
        if (!Number.isFinite(bookingId)) {
            throw new errorHandler_1.AppError('Invalid booking id', 400);
        }
        const { booking, tickets } = await bookingService_1.bookingService.getBooking(bookingId, req.user.id);
        res.json({ success: true, data: { booking, tickets } });
        return;
    }
    catch (err) {
        return next(err);
    }
}
