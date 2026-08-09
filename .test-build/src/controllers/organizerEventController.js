"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listEvents = listEvents;
exports.getEvent = getEvent;
exports.createEvent = createEvent;
exports.updateEvent = updateEvent;
exports.deleteEvent = deleteEvent;
exports.getEventTicketTiers = getEventTicketTiers;
exports.getEventSeats = getEventSeats;
exports.createEventSeats = createEventSeats;
const organizerEventService_1 = require("../services/organizerEventService");
async function listEvents(req, res, next) {
    try {
        const userId = req.organizerUser.id;
        const organizationId = req.organizerUser.organizationId;
        const { page = 1, pageSize = 20, search, status } = req.query;
        const data = await organizerEventService_1.organizerEventService.listForOrganization(organizationId, {
            page: Number(page),
            pageSize: Number(pageSize),
            search: search || undefined,
            status: (status || undefined),
        });
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
}
async function getEvent(req, res, next) {
    try {
        const event = await organizerEventService_1.organizerEventService.getById(Number(req.params.id), req.organizerUser.id);
        res.json({ success: true, data: event });
    }
    catch (err) {
        next(err);
    }
}
async function createEvent(req, res, next) {
    try {
        const data = await organizerEventService_1.organizerEventService.create({ ...req.body, organization_id: req.organizerUser.organizationId }, req.organizerUser.id);
        res.status(201).json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
}
async function updateEvent(req, res, next) {
    try {
        const data = await organizerEventService_1.organizerEventService.update(Number(req.params.id), req.body, req.organizerUser.id);
        res.json({ success: true, data });
    }
    catch (err) {
        next(err);
    }
}
async function deleteEvent(req, res, next) {
    try {
        await organizerEventService_1.organizerEventService.delete(Number(req.params.id), req.organizerUser.id);
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
async function getEventTicketTiers(req, res, next) {
    try {
        const tiers = await organizerEventService_1.organizerEventService.getTicketTiers(Number(req.params.id), req.organizerUser.id);
        res.json({ success: true, data: tiers });
    }
    catch (err) {
        next(err);
    }
}
async function getEventSeats(req, res, next) {
    try {
        const seats = await organizerEventService_1.organizerEventService.getSeats(Number(req.params.id), req.organizerUser.id);
        res.json({ success: true, data: seats });
    }
    catch (err) {
        next(err);
    }
}
async function createEventSeats(req, res, next) {
    try {
        const result = await organizerEventService_1.organizerEventService.createSeats(Number(req.params.id), req.body, req.organizerUser.id);
        res.status(201).json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
