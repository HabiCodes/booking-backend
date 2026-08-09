"use strict";
/**
 * Organizer event service — CRUD for events owned by an organization.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerEventService = exports.OrganizerEventService = void 0;
const errorHandler_1 = require("../middleware/errorHandler");
const eventRepository_1 = require("../repositories/eventRepository");
const ticketTierRepository_1 = require("../repositories/ticketTierRepository");
const seatRepository_1 = require("../repositories/seatRepository");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
class OrganizerEventService {
    async listForOrganization(organizationId, query) {
        return eventRepository_1.eventRepository.findByOrganization(organizationId, query);
    }
    async getById(id, requesterId) {
        const event = await eventRepository_1.eventRepository.getEventById(id);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== event.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        return event;
    }
    async create(input, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== input.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        return eventRepository_1.eventRepository.create(input);
    }
    async update(id, input, requesterId) {
        const existing = await eventRepository_1.eventRepository.getEventById(id);
        if (!existing)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== existing.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        const updated = await eventRepository_1.eventRepository.update(id, input);
        if (!updated)
            throw new errorHandler_1.AppError('Event not found', 404);
        return updated;
    }
    async delete(id, requesterId) {
        const event = await eventRepository_1.eventRepository.getEventById(id);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== event.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        await eventRepository_1.eventRepository.softDelete(id);
    }
    async getTicketTiers(eventId, requesterId) {
        const event = await eventRepository_1.eventRepository.getEventById(eventId);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== event.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        return ticketTierRepository_1.ticketTierRepository.findByEvent(eventId);
    }
    async getSeats(eventId, requesterId) {
        const event = await eventRepository_1.eventRepository.getEventById(eventId);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== event.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        return seatRepository_1.seatRepository.findByEvent(eventId);
    }
    async createSeats(eventId, bulk, requesterId) {
        const event = await eventRepository_1.eventRepository.getEventById(eventId);
        if (!event)
            throw new errorHandler_1.AppError('Event not found', 404);
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== event.organization_id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        return seatRepository_1.seatRepository.bulkCreate(eventId, bulk);
    }
}
exports.OrganizerEventService = OrganizerEventService;
// ── Singleton ──────────────────────────────────────────────────────────────
const organizerEventService = new OrganizerEventService();
exports.organizerEventService = organizerEventService;
