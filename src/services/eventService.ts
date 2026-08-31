import { eventRepository } from '../repositories/eventRepository';
import { eventZoneRepository } from '../repositories/eventZoneRepository';
import type {
  EventCreateInput,
  EventListQuery,
  EventListResult,
  EventRow,
  EventUpdateInput,
} from '../types';
import { AppError } from '../middleware/errorHandler';

export class EventService {
  // ── Reads ─────────────────────────────────────────────────────────────────

  async getActiveEvent(): Promise<EventRow | null> {
    return eventRepository.getActiveEvent();
  }

  async getEventById(id: number): Promise<EventRow | null> {
    return eventRepository.getEventById(id);
  }

  async listPublicEvents(query: EventListQuery): Promise<EventListResult> {
    return eventRepository.listPublicEvents(query);
  }

  async listAllEvents(query: EventListQuery, organizationId?: number | null): Promise<EventListResult> {
    return eventRepository.listAllEvents(query, organizationId);
  }

  async listFeaturedEvents(limit: number = 5): Promise<EventRow[]> {
    return eventRepository.listFeaturedEvents(limit);
  }

  async listPublicCategories(): Promise<Array<{ category: string; count: number }>> {
    return eventRepository.listPublicCategories();
  }

  async listPublicCities(): Promise<Array<{ city: string; count: number }>> {
    return eventRepository.listPublicCities();
  }

  async listRelatedEvents(eventId: number, category: string | null, limit: number = 4): Promise<EventRow[]> {
    return eventRepository.listRelatedEvents(eventId, category, limit);
  }

  /**
   * Public-facing event detail. Returns the event plus live stats and
   * related events. Returns null if the event is not publicly visible
   * (deleted, draft, hidden, private, unlisted).
   */
  async getPublicEventDetail(eventId: number): Promise<{
    event: EventRow;
    stats: { capacity: number; bookedCount: number; remaining: number };
    related: EventRow[];
  } | null> {
    const event = await eventRepository.getEventById(eventId);
    if (!event) return null;
    if (event.deleted_at !== null) return null;
    if (event.status !== 'published') return null;
    if (event.visibility !== 'public') return null;

    const stats = await eventRepository.getBookingStats(eventId);
    const related = await eventRepository.listRelatedEvents(eventId, event.category, 4);

    return { event, stats, related };
  }

  async getBookingStats(eventId: number) {
    return eventRepository.getBookingStats(eventId);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  async createEvent(input: EventCreateInput): Promise<number> {
    if (!input.title) {
      throw new AppError('Event title is required', 400);
    }
    if (!input.venue) {
      throw new AppError('Event venue is required', 400);
    }
    if (!input.start_at || !input.end_at) {
      throw new AppError('Event start_at and end_at are required', 400);
    }
    if (input.capacity === undefined || input.capacity <= 0) {
      throw new AppError('Capacity must be a positive number', 400);
    }
    if (input.capacity > 1000000) {
      throw new AppError('Capacity cannot exceed 1,000,000', 400);
    }
    if (new Date(input.end_at) <= new Date(input.start_at)) {
      throw new AppError('end_at must be after start_at', 400);
    }
    if (new Date(input.start_at) < new Date()) {
      throw new AppError('Event start_at cannot be in the past', 400);
    }

    // ── Free/paid event consistency ───────────────────────────────────────────
    const isFree = input.is_free ?? false;
    const price = Number(input.price ?? 0);
    if (isFree && price !== 0) {
      throw new AppError('Free events must have price = 0', 400);
    }
    if (!isFree && price <= 0) {
      throw new AppError('Paid events must have a price greater than 0', 400);
    }
    if (price > 999999) {
      throw new AppError('Price cannot exceed 999,999', 400);
    }

    return eventRepository.create(input);
  }

  async updateEvent(id: number, input: EventUpdateInput): Promise<EventRow> {
    // Fetch existing event to validate changes against current state
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found or already deleted', 404);

    // Validate free/paid consistency
    const isFree = input.is_free ?? existing.is_free;
    const price = input.price !== undefined ? Number(input.price) : Number(existing.price);

    if (isFree && price !== 0) {
      throw new AppError('Free events must have price = 0', 400);
    }
    if (!isFree && price <= 0) {
      throw new AppError('Paid events must have a price greater than 0', 400);
    }
    if (price > 999999) {
      throw new AppError('Price cannot exceed 999,999', 400);
    }

    // Free events must not have zones — check at service level for defense in depth
    const becomingFree = isFree && !existing.is_free;
    if (becomingFree) {
      const zones = await eventZoneRepository.getActiveZonesByEvent(id);
      if (zones.length > 0) {
        throw new AppError(
          'Cannot convert to free event: this event has zones. Delete all zones first.',
          400
        );
      }
    }

    // Validate capacity
    if (input.capacity !== undefined) {
      if (input.capacity <= 0) {
        throw new AppError('Capacity must be a positive number', 400);
      }
      if (input.capacity > 1000000) {
        throw new AppError('Capacity cannot exceed 1,000,000', 400);
      }
    }

    // Validate dates
    const startAt = input.start_at ?? existing.start_at;
    const endAt = input.end_at ?? existing.end_at;
    if (new Date(endAt) <= new Date(startAt)) {
      throw new AppError('end_at must be after start_at', 400);
    }
    if (new Date(startAt) < new Date()) {
      throw new AppError('Event start_at cannot be in the past', 400);
    }

    const updated = await eventRepository.update(id, input);
    if (!updated) throw new AppError('Event not found or already deleted', 404);
    return updated;
  }

  async publishEvent(id: number): Promise<{ success: boolean; event?: EventRow }> {
    const ok = await eventRepository.publish(id);
    if (!ok) throw new AppError('Event not found', 404);
    const event = await eventRepository.getEventById(id);
    return { success: ok, event: event ?? undefined };
  }

  async hideEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.hide(id);
    if (!ok) throw new AppError('Event not found', 404);
    return ok;
  }

  async cancelEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.cancel(id);
    if (!ok) throw new AppError('Event not found', 404);
    return ok;
  }

  async setFeatured(id: number, isFeatured: boolean): Promise<boolean> {
    const ok = await eventRepository.setFeatured(id, isFeatured);
    if (!ok) throw new AppError('Event not found', 404);
    return ok;
  }

  async deleteEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.softDelete(id);
    if (!ok) throw new AppError('Event not found or already deleted', 404);
    return ok;
  }

  async restoreEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.restore(id);
    if (!ok) throw new AppError('Event not found', 404);
    return ok;
  }

  // ── Booking integration ───────────────────────────────────────────────────

  async reserveCapacity(eventId: number, count: number): Promise<boolean> {
    const remaining = await eventRepository.decrementRemainingCapacity(eventId, count);
    return remaining > 0 || (await eventRepository.getEventCapacity(eventId)) >= count;
  }

  async releaseCapacity(eventId: number, count: number): Promise<void> {
    await eventRepository.incrementRemainingCapacity(eventId, count);
  }
}

export const eventService = new EventService();