/**
 * Organizer Event Approval Service.
 *
 * Handles the organizer ↔ Super Admin event approval workflow:
 *   DRAFT → SUBMITTED → APPROVED → (event becomes live)
 *                → REJECTED  → (organizer edits → SUBMITTED)
 *
 * All state transitions are wrapped in a transaction and logged to
 * organizer_event_history.
 *
 * IMPORTANT: Every status change is server-side only. The organizer_status
 * column on the events table is the single source of truth for whether an
 * event can be published.
 */

import { withTransaction } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import type { EventRow, EventOrganizerStatus, EventOrganizerReviewInput, OrganizerEventHistoryRow } from '../types';

import { eventRepository } from '../repositories/eventRepository';
import { organizerAppRepository } from '../repositories/organizerAppRepository';

export type EventApprovalAction = 'submit' | 'approve' | 'reject';

// ── Service ───────────────────────────────────────────────────────────────────

export class OrganizerEventApprovalService {
  /**
   * Organizer submits a draft event for Super Admin review.
   * Sets organizer_status to 'submitted' and records the submitted_at timestamp.
   */
  async submitForReview(eventId: number, organizationId: number): Promise<EventRow> {
    return withTransaction(async () => {
      const event = await eventRepository.getEventById(eventId);
      if (!event) throw new AppError('Event not found', 404);
      if (event.organization_id !== organizationId) {
        throw new AppError('Forbidden: event does not belong to your organization', 403);
      }
      if (event.organizer_status === 'submitted') {
        throw new AppError('Event is already pending review', 409);
      }
      if (event.organizer_status === 'approved') {
        throw new AppError('Event has already been approved', 409);
      }
      if (event.organizer_status === 'rejected') {
        throw new AppError('Rejected event must be re-created. Create a new event.', 409);
      }
      if (event.deleted_at) {
        throw new AppError('Cannot submit a deleted event', 409);
      }

      const now = new Date().toISOString();
      const updated = await eventRepository.updateOrganizerStatus(eventId, 'submitted', { submitted_at: now });

      // Log the transition
      await eventRepository.addEventHistory({
        eventId,
        organizationId,
        actor_type: 'organizer_user',
        to_status: 'submitted',
        reason: 'Submitted for review',
      });

      logger.info('Event submitted for review', { eventId, organizationId });
      return updated || event;
    });
  }

  /**
   * Super Admin approves a submitted event.
   * Sets organizer_status to 'approved'. The event now CAN go live when
   * the admin also publishes it via the standard lifecycle.
   */
  async approveEvent(
    eventId: number,
    reviewer: { adminId: number; name: string },
    reason?: string | null,
  ): Promise<EventRow> {
    return withTransaction(async () => {
      const event = await eventRepository.getEventById(eventId);
      if (!event) throw new AppError('Event not found', 404);

      if (event.organizer_status !== 'submitted') {
        throw new AppError(`Event must be in 'submitted' status to approve (current: ${event.organizer_status || event.status})`, 409);
      }

      const now = new Date().toISOString();
      const updated = await eventRepository.updateOrganizerStatus(eventId, 'approved', {
        reviewed_by: reviewer.adminId,
        reviewed_at: now,
      });

      await eventRepository.addEventHistory({
        eventId,
        organizationId: event.organization_id!,
        actor_type: 'admin',
        actor_admin_id: reviewer.adminId,
        from_status: event.organizer_status || 'draft',
        to_status: 'approved',
        reason: reason || 'Event approved',
      });

      logger.info('Event approved', { eventId, adminId: reviewer.adminId });
      return updated || event;
    });
  }

  /**
   * Super Admin rejects a submitted event.
   * Sets organizer_status to 'rejected'. Organizer must edit and resubmit.
   */
  async rejectEvent(
    eventId: number,
    reviewer: { adminId: number; name: string },
    reason: string,
  ): Promise<EventRow> {
    if (!reason || !reason.trim()) {
      throw new AppError('A rejection reason is required', 400);
    }

    return withTransaction(async () => {
      const event = await eventRepository.getEventById(eventId);
      if (!event) throw new AppError('Event not found', 404);

      if (event.organizer_status !== 'submitted') {
        throw new AppError(`Event must be in 'submitted' status to reject (current: ${event.organizer_status || event.status})`, 409);
      }

      const now = new Date().toISOString();
      const updated = await eventRepository.updateOrganizerStatus(eventId, 'rejected', {
        reviewed_by: reviewer.adminId,
        reviewed_at: now,
        rejection_reason: reason.trim(),
      });

      await eventRepository.addEventHistory({
        eventId,
        organizationId: event.organization_id!,
        actor_type: 'admin',
        actor_admin_id: reviewer.adminId,
        from_status: event.organizer_status || 'submitted',
        to_status: 'rejected',
        reason: reason.trim(),
      });

      logger.info('Event rejected', { eventId, adminId: reviewer.adminId, reason: reason.trim() });
      return updated || event;
    });
  }

  /**
   * Review (list) pending events for a specific organization or all organizations
   * (for Super Admin). Returns events that are in 'submitted' organizer_status.
   */
  async listPendingEvents(organizationId?: number): Promise<EventRow[]> {
    return eventRepository.findPendingReviewOrganizer(organizationId);
  }

  /**
   * Get event approval info including review history.
   */
  async getEventApprovalInfo(eventId: number): Promise<{
    event: EventRow;
    history: OrganizerEventHistoryRow[];
  } | null> {
    return eventRepository.findWithOrganizerHistory(eventId);
  }
}

export const organizerEventApprovalService = new OrganizerEventApprovalService();
