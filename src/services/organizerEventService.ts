/**
 * Organizer event service — CRUD for events owned by an organization.
 */

import { AppError } from '../middleware/errorHandler';
import { eventRepository } from '../repositories/eventRepository';
import { venueRepository } from '../repositories/venueRepository';
import { ticketTierRepository } from '../repositories/ticketTierRepository';
import { seatRepository } from '../repositories/seatRepository';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import type {
  EventRow,
  EventCreateInput,
  EventUpdateInput,
  EventListQuery,
  TicketTierRow,
  SeatBulkCreateInput,
} from '../types';

export class OrganizerEventService {
  async listForOrganization(organizationId: number, query: EventListQuery) {
    return eventRepository.findByOrganization(organizationId, query);
  }

  async getById(id: number, requesterId: number): Promise<EventRow> {
    const event = await eventRepository.getEventById(id);
    if (!event) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== event.organization_id) throw new AppError('Forbidden', 403);
    return event;
  }

  async create(input: EventCreateInput & { organization_id: number }, requesterId: number): Promise<number> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== input.organization_id) throw new AppError('Forbidden', 403);
    return eventRepository.create(input);
  }

  async update(id: number, input: EventUpdateInput, requesterId: number): Promise<EventRow> {
    const existing = await eventRepository.getEventById(id);
    if (!existing) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== existing.organization_id) throw new AppError('Forbidden', 403);
    const updated = await eventRepository.update(id, input) as EventRow | null;
    if (!updated) throw new AppError('Event not found', 404);
    return updated;
  }

  async delete(id: number, requesterId: number): Promise<void> {
    const event = await eventRepository.getEventById(id);
    if (!event) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== event.organization_id) throw new AppError('Forbidden', 403);
    await eventRepository.softDelete(id);
  }

  async getTicketTiers(eventId: number, requesterId: number): Promise<TicketTierRow[]> {
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== event.organization_id) throw new AppError('Forbidden', 403);
    return ticketTierRepository.findByEvent(eventId);
  }

  async getSeats(eventId: number, requesterId: number) {
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== event.organization_id) throw new AppError('Forbidden', 403);
    return seatRepository.findByEvent(eventId);
  }

  async createSeats(eventId: number, bulk: SeatBulkCreateInput, requesterId: number) {
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== event.organization_id) throw new AppError('Forbidden', 403);
    return seatRepository.bulkCreate(eventId, bulk);
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
const organizerEventService = new OrganizerEventService();
export { organizerEventService };
