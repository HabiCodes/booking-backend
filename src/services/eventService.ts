import { eventRepository } from '../repositories/eventRepository';
import type {
  EventCreateInput,
  EventListQuery,
  EventListResult,
  EventRow,
  EventUpdateInput,
} from '../types';

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

  async listAllEvents(query: EventListQuery): Promise<EventListResult> {
    return eventRepository.listAllEvents(query);
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
      throw new Error('Event title is required') as Error & { statusCode?: number };
    }
    if (!input.venue) {
      throw new Error('Event venue is required') as Error & { statusCode?: number };
    }
    if (!input.start_at || !input.end_at) {
      throw new Error('Event start_at and end_at are required') as Error & { statusCode?: number };
    }
    if (input.capacity === undefined || input.capacity <= 0) {
      throw new Error('Capacity must be a positive number') as Error & { statusCode?: number };
    }
    if (new Date(input.end_at) <= new Date(input.start_at)) {
      throw new Error('end_at must be after start_at') as Error & { statusCode?: number };
    }

    return eventRepository.create(input);
  }

  async updateEvent(id: number, input: EventUpdateInput): Promise<EventRow> {
    const updated = await eventRepository.update(id, input);
    if (!updated) throw new Error('Event not found or already deleted') as Error & { statusCode?: number };
    return updated;
  }

  async publishEvent(id: number): Promise<{ success: boolean; event?: EventRow }> {
    const ok = await eventRepository.publish(id);
    if (!ok) throw new Error('Event not found') as Error & { statusCode?: number };
    const event = await eventRepository.getEventById(id);
    return { success: ok, event: event ?? undefined };
  }

  async hideEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.hide(id);
    if (!ok) throw new Error('Event not found') as Error & { statusCode?: number };
    return ok;
  }

  async cancelEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.cancel(id);
    if (!ok) throw new Error('Event not found') as Error & { statusCode?: number };
    return ok;
  }

  async setFeatured(id: number, isFeatured: boolean): Promise<boolean> {
    const ok = await eventRepository.setFeatured(id, isFeatured);
    if (!ok) throw new Error('Event not found') as Error & { statusCode?: number };
    return ok;
  }

  async deleteEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.softDelete(id);
    if (!ok) throw new Error('Event not found or already deleted') as Error & { statusCode?: number };
    return ok;
  }

  async restoreEvent(id: number): Promise<boolean> {
    const ok = await eventRepository.restore(id);
    if (!ok) throw new Error('Event not found') as Error & { statusCode?: number };
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