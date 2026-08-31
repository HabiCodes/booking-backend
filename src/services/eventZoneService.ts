/**
 * Event Zone Service — business logic for layout-based paid event zones.
 *
 * Event types and zones:
 *   - Free events:    NO zones allowed. Enforced by validateFreeEventNoZones().
 *   - Normal paid:    Price is in the events table, no zones needed.
 *   - Layout paid:    Zones define the price tiers. events.price is NOT used
 *                     for layout-based events (derived from zones instead).
 *
 * Capacity model:
 *   event_zones.remaining_capacity tracks per-zone capacity independently.
 *   events.remaining_capacity tracks the GLOBAL event capacity.
 *   Both are decremented atomically in the booking flow.
 *
 * Booking flow for layout-based events:
 *   1. User selects zone_id + quantity
 *   2. Backend checks zone.remaining_capacity >= quantity
 *   3. Atomically decrement zone.remaining_capacity
 *   4. Also decrement events.remaining_capacity (global cap)
 *   5. Create booking + tickets
 *   6. Record in booking_zones join table
 */

import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { withTransaction, getPool } from '../db/pool';
import { eventRepository } from '../repositories/eventRepository';
import { eventZoneRepository } from '../repositories/eventZoneRepository';
import type {
  EventZoneRow,
  EventZonePublic,
  EventZoneCreateInput,
  EventZoneUpdateInput,
} from '../types';

export class EventZoneService {

  /**
   * Validate that a free event does NOT have zones.
   * Returns the active zones (should be empty for free events).
   */
  async validateFreeEventNoZones(eventId: number): Promise<EventZoneRow[]> {
    const zones = await eventZoneRepository.getActiveZonesByEvent(eventId);
    if (zones.length > 0) {
      throw new AppError('Free events cannot have zones. Remove all zones before setting the event as free.', 400);
    }
    return zones;
  }

  /**
   * Validate that an event is layout-based (has active zones).
   */
  async validateEventIsLayoutBased(eventId: number): Promise<boolean> {
    const zones = await eventZoneRepository.getActiveZonesByEvent(eventId);
    if (zones.length === 0) {
      throw new AppError('This event does not have any zones configured. Use the price field for a normal paid event, or add zones for a layout-based event.', 400);
    }
    return true;
  }

  /**
   * List zones for an event.
   */
  async listZones(eventId: number): Promise<EventZonePublic[]> {
    const zones = await eventZoneRepository.getZonesByEvent(eventId, true);
    return zones.map(z => ({
      id: z.id,
      event_id: z.event_id,
      name: z.name,
      description: z.description,
      color: z.color,
      total_capacity: z.total_capacity,
      remaining_capacity: z.remaining_capacity,
      price: Number(z.price),
      currency: z.currency,
      sort_order: z.sort_order,
      is_active: z.is_active,
    }));
  }

  /**
   * Get a single zone by ID (public — only active zones).
   */
  async getZone(zoneId: number): Promise<EventZonePublic> {
    const zone = await eventZoneRepository.getActiveZoneById(zoneId);
    if (!zone) throw new AppError('Zone not found', 404);
    return {
      id: zone.id,
      event_id: zone.event_id,
      name: zone.name,
      description: zone.description,
      color: zone.color,
      total_capacity: zone.total_capacity,
      remaining_capacity: zone.remaining_capacity,
      price: Number(zone.price),
      currency: zone.currency,
      sort_order: zone.sort_order,
      is_active: zone.is_active,
    };
  }

  /**
   * Create a zone for an event.
   *
   * Business rules:
   *   - Free events cannot have zones
   *   - Zone name must be unique within the event
   *   - total_capacity must be >= 0
   *   - price must be >= 0
   */
  async createZone(eventId: number, input: EventZoneCreateInput): Promise<EventZonePublic> {
    // Verify event exists
    const event = await eventRepository.getEventById(eventId);
    if (!event) throw new AppError('Event not found', 404);

    // Free events cannot have zones
    if (event.is_free) {
      throw new AppError('Cannot add zones to a free event', 400);
    }

    // Check for duplicate zone name
    const existing = await eventZoneRepository.getZoneByName(eventId, input.name);
    if (existing && !existing.deleted_at) {
      throw new AppError(`A zone named "${input.name}" already exists for this event`, 409);
    }

    // Validate capacity
    if (input.total_capacity < 0) {
      throw new AppError('Zone capacity must be a non-negative number', 400);
    }
    if (input.total_capacity === 0) {
      throw new AppError('Zone capacity must be greater than 0', 400);
    }

    // Validate price
    if (input.price < 0) {
      throw new AppError('Zone price must be a non-negative number', 400);
    }

    // Determine sort_order (append after last)
    const existingZones = await eventZoneRepository.getZonesByEvent(eventId, true);
    const maxSort = existingZones.reduce((max, z) => Math.max(max, z.sort_order), -1);
    const sortOrder = input.sort_order ?? maxSort + 1;

    const zone = await eventZoneRepository.createZone({
      event_id: eventId,
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? null,
      total_capacity: input.total_capacity,
      price: input.price,
      currency: input.currency ?? 'INR',
      sort_order: sortOrder,
    });

    logger.info('Zone created', { zoneId: zone.id, eventId, name: zone.name, capacity: zone.total_capacity, price: zone.price });

    return {
      id: zone.id,
      event_id: zone.event_id,
      name: zone.name,
      description: zone.description,
      color: zone.color,
      total_capacity: zone.total_capacity,
      remaining_capacity: zone.remaining_capacity,
      price: Number(zone.price),
      currency: zone.currency,
      sort_order: zone.sort_order,
      is_active: zone.is_active,
    };
  }

  /**
   * Update a zone.
   */
  async updateZone(zoneId: number, input: EventZoneUpdateInput): Promise<EventZonePublic> {
    const existing = await eventZoneRepository.getZoneById(zoneId);
    if (!existing) throw new AppError('Zone not found', 404);

    // If renaming, check for uniqueness
    if (input.name && input.name !== existing.name) {
      const dup = await eventZoneRepository.getZoneByName(existing.event_id, input.name);
      if (dup && !dup.deleted_at) {
        throw new AppError(`A zone named "${input.name}" already exists for this event`, 409);
      }
    }

    // Validate capacity if being updated
    if (input.total_capacity !== undefined && input.total_capacity < 0) {
      throw new AppError('Zone capacity must be a non-negative number', 400);
    }

    // Validate price if being updated
    if (input.price !== undefined && input.price < 0) {
      throw new AppError('Zone price must be a non-negative number', 400);
    }

    const zone = await eventZoneRepository.updateZone(zoneId, input);
    if (!zone) throw new AppError('Zone not found', 404);

    logger.info('Zone updated', { zoneId, name: zone.name });

    return {
      id: zone.id,
      event_id: zone.event_id,
      name: zone.name,
      description: zone.description,
      color: zone.color,
      total_capacity: zone.total_capacity,
      remaining_capacity: zone.remaining_capacity,
      price: Number(zone.price),
      currency: zone.currency,
      sort_order: zone.sort_order,
      is_active: zone.is_active,
    };
  }

  /**
   * Soft-delete a zone.
   */
  async deleteZone(zoneId: number): Promise<void> {
    const zone = await eventZoneRepository.getZoneById(zoneId);
    if (!zone) throw new AppError('Zone not found', 404);

    await eventZoneRepository.softDeleteZone(zoneId);
    logger.info('Zone deleted', { zoneId, eventId: zone.event_id });
  }

  /**
   * Get remaining tickets per zone for an event.
   */
  async getZoneAvailability(eventId: number): Promise<Array<{
    zone_id: number;
    zone_name: string;
    total_capacity: number;
    remaining_capacity: number;
    price: number;
    currency: string;
    color: string | null;
    is_active: boolean;
  }>> {
    const zones = await eventZoneRepository.getZonesByEvent(eventId, true);
    return zones.map(z => ({
      zone_id: z.id,
      zone_name: z.name,
      total_capacity: z.total_capacity,
      remaining_capacity: z.remaining_capacity,
      price: Number(z.price),
      currency: z.currency,
      color: z.color,
      is_active: z.is_active,
    }));
  }
}

export const eventZoneService = new EventZoneService();
