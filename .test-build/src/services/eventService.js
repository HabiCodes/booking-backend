"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventService = exports.EventService = void 0;
const eventRepository_1 = require("../repositories/eventRepository");
class EventService {
    // ── Reads ─────────────────────────────────────────────────────────────────
    async getActiveEvent() {
        return eventRepository_1.eventRepository.getActiveEvent();
    }
    async getEventById(id) {
        return eventRepository_1.eventRepository.getEventById(id);
    }
    async listPublicEvents(query) {
        return eventRepository_1.eventRepository.listPublicEvents(query);
    }
    async listAllEvents(query) {
        return eventRepository_1.eventRepository.listAllEvents(query);
    }
    async listFeaturedEvents(limit = 5) {
        return eventRepository_1.eventRepository.listFeaturedEvents(limit);
    }
    async listPublicCategories() {
        return eventRepository_1.eventRepository.listPublicCategories();
    }
    async listPublicCities() {
        return eventRepository_1.eventRepository.listPublicCities();
    }
    async listRelatedEvents(eventId, category, limit = 4) {
        return eventRepository_1.eventRepository.listRelatedEvents(eventId, category, limit);
    }
    /**
     * Public-facing event detail. Returns the event plus live stats and
     * related events. Returns null if the event is not publicly visible
     * (deleted, draft, hidden, private, unlisted).
     */
    async getPublicEventDetail(eventId) {
        const event = await eventRepository_1.eventRepository.getEventById(eventId);
        if (!event)
            return null;
        if (event.deleted_at !== null)
            return null;
        if (event.status !== 'published')
            return null;
        if (event.visibility !== 'public')
            return null;
        const stats = await eventRepository_1.eventRepository.getBookingStats(eventId);
        const related = await eventRepository_1.eventRepository.listRelatedEvents(eventId, event.category, 4);
        return { event, stats, related };
    }
    async getBookingStats(eventId) {
        return eventRepository_1.eventRepository.getBookingStats(eventId);
    }
    // ── Mutations ─────────────────────────────────────────────────────────────
    async createEvent(input) {
        if (!input.title) {
            throw new Error('Event title is required');
        }
        if (!input.venue) {
            throw new Error('Event venue is required');
        }
        if (!input.start_at || !input.end_at) {
            throw new Error('Event start_at and end_at are required');
        }
        if (input.capacity === undefined || input.capacity <= 0) {
            throw new Error('Capacity must be a positive number');
        }
        if (new Date(input.end_at) <= new Date(input.start_at)) {
            throw new Error('end_at must be after start_at');
        }
        return eventRepository_1.eventRepository.create(input);
    }
    async updateEvent(id, input) {
        const updated = await eventRepository_1.eventRepository.update(id, input);
        if (!updated)
            throw new Error('Event not found or already deleted');
        return updated;
    }
    async publishEvent(id) {
        const ok = await eventRepository_1.eventRepository.publish(id);
        if (!ok)
            throw new Error('Event not found');
        const event = await eventRepository_1.eventRepository.getEventById(id);
        return { success: ok, event: event ?? undefined };
    }
    async hideEvent(id) {
        const ok = await eventRepository_1.eventRepository.hide(id);
        if (!ok)
            throw new Error('Event not found');
        return ok;
    }
    async cancelEvent(id) {
        const ok = await eventRepository_1.eventRepository.cancel(id);
        if (!ok)
            throw new Error('Event not found');
        return ok;
    }
    async setFeatured(id, isFeatured) {
        const ok = await eventRepository_1.eventRepository.setFeatured(id, isFeatured);
        if (!ok)
            throw new Error('Event not found');
        return ok;
    }
    async deleteEvent(id) {
        const ok = await eventRepository_1.eventRepository.softDelete(id);
        if (!ok)
            throw new Error('Event not found or already deleted');
        return ok;
    }
    async restoreEvent(id) {
        const ok = await eventRepository_1.eventRepository.restore(id);
        if (!ok)
            throw new Error('Event not found');
        return ok;
    }
    // ── Booking integration ───────────────────────────────────────────────────
    async reserveCapacity(eventId, count) {
        const remaining = await eventRepository_1.eventRepository.decrementRemainingCapacity(eventId, count);
        return remaining > 0 || (await eventRepository_1.eventRepository.getEventCapacity(eventId)) >= count;
    }
    async releaseCapacity(eventId, count) {
        await eventRepository_1.eventRepository.incrementRemainingCapacity(eventId, count);
    }
}
exports.EventService = EventService;
exports.eventService = new EventService();
