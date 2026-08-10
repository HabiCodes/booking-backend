"use strict";
/**
 * Turf venue controller — organizer CRUD for turf venues and resources.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listVenues = listVenues;
exports.createVenue = createVenue;
exports.getVenue = getVenue;
exports.updateVenue = updateVenue;
exports.deleteVenue = deleteVenue;
exports.createResource = createResource;
exports.listResources = listResources;
exports.getResource = getResource;
exports.updateResource = updateResource;
exports.listSlots = listSlots;
exports.generateSlots = generateSlots;
const errorHandler_1 = require("../../middleware/errorHandler");
const turfVenueService_1 = require("../../services/turfVenueService");
const turfAvailabilityService_1 = require("../../services/turfAvailabilityService");
async function listVenues(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const venues = await turfVenueService_1.turfVenueService.listByOrganization(orgId);
        res.json({ success: true, data: venues });
    }
    catch (err) {
        next(err);
    }
}
async function createVenue(req, res, next) {
    try {
        const orgId = req.organizerUser?.organization_id;
        const venue = await turfVenueService_1.turfVenueService.create(orgId, req.body);
        res.status(201).json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
}
async function getVenue(req, res, next) {
    try {
        const venue = await turfVenueService_1.turfVenueService.getById(Number(req.params.venueId));
        res.json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
}
async function updateVenue(req, res, next) {
    try {
        const venue = await turfVenueService_1.turfVenueService.update(Number(req.params.venueId), req.body);
        res.json({ success: true, data: venue });
    }
    catch (err) {
        next(err);
    }
}
async function deleteVenue(req, res, next) {
    try {
        await turfVenueService_1.turfVenueService.softDelete(Number(req.params.venueId));
        res.json({ success: true, message: 'Venue deleted' });
    }
    catch (err) {
        next(err);
    }
}
async function createResource(req, res, next) {
    try {
        const resource = await turfVenueService_1.turfVenueService.createResource(Number(req.params.venueId), req.body);
        res.status(201).json({ success: true, data: resource });
    }
    catch (err) {
        next(err);
    }
}
async function listResources(req, res, next) {
    try {
        const result = await turfVenueService_1.turfVenueService.listResources(Number(req.params.venueId), req.query);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function getResource(req, res, next) {
    try {
        const resource = await turfVenueService_1.turfVenueService.getResource(Number(req.params.resourceId));
        res.json({ success: true, data: resource });
    }
    catch (err) {
        next(err);
    }
}
async function updateResource(req, res, next) {
    try {
        const resource = await turfVenueService_1.turfVenueService.updateResource(Number(req.params.resourceId), req.body);
        res.json({ success: true, data: resource });
    }
    catch (err) {
        next(err);
    }
}
async function listSlots(req, res, next) {
    try {
        const resourceId = Number(req.params.resourceId);
        const date = String(req.query.date || '').trim();
        if (!date)
            throw new errorHandler_1.AppError('date (YYYY-MM-DD) required', 400);
        const slots = await turfAvailabilityService_1.turfAvailabilityService.listSlots(resourceId, date);
        res.json({ success: true, data: { slots, date } });
    }
    catch (err) {
        next(err);
    }
}
async function generateSlots(req, res, next) {
    try {
        const resourceId = Number(req.params.resourceId);
        const { date, startTime, endTime, slotDurationMinutes, price } = req.body;
        const result = await turfAvailabilityService_1.turfAvailabilityService.generateSlots(resourceId, date, startTime, endTime, slotDurationMinutes, price);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
