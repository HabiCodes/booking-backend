/**
 * Event Lifecycle Service — state machine for the event workflow.
 *
 *   draft ──submit_for_review──▶ pending_review ──approve──▶ approved
 *                                                                    │
 *                                                                    ├──publish──▶ published
 *                                                                    │                 │
 *                                                                    │                 ├──hide──▶ hidden
 *                                                                    │                 │         │
 *                                                                    │                 │         └──show──▶ published
 *                                                                    │                 │
 *                                                                    │                 └──unpublish──▶ approved
 *                                                                    │
 *                                                                    └──reject──▶ draft
 *
 *   <any> ──archive──▶ archived ──restore──▶ <previous>
 *   <any> ──cancel──▶ cancelled (terminal)
 *
 * The state machine table is the single source of truth.  Every transition
 * is wrapped in a transaction so the events.status update and the
 * event_status_history insert happen atomically.
 */

import { withTransaction } from '../db/pool';
import { eventRepository } from '../repositories/eventRepository';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import type {
  EventLifecycleAction,
  EventRow,
  EventStatus,
  EventStatusHistoryPublic,
  EventStatusHistoryRow,
  EventStatusTransitionInput,
} from '../types';

// ── State machine ────────────────────────────────────────────────────────────

/**
 * Map: (currentStatus, action) → newStatus
 */
const TRANSITIONS: ReadonlyMap<string, EventStatus> = new Map<string, EventStatus>([
  // creation / review
  ['draft:submit_for_review', 'pending_review'],
  ['pending_review:approve', 'approved'],
  ['pending_review:reject', 'draft'],

  // publication
  ['approved:publish', 'published'],
  ['published:unpublish', 'approved'],

  // visibility
  ['published:hide', 'hidden'],
  ['hidden:show', 'published'],

  // archival
  ['draft:archive', 'archived'],
  ['pending_review:archive', 'archived'],
  ['approved:archive', 'archived'],
  ['published:archive', 'archived'],
  ['hidden:archive', 'archived'],
  ['archived:restore', 'draft'], // restored as a draft — must walk through review again

  // cancellation (from any non-terminal state)
  ['draft:cancel', 'cancelled'],
  ['pending_review:cancel', 'cancelled'],
  ['approved:cancel', 'cancelled'],
  ['published:cancel', 'cancelled'],
  ['hidden:cancel', 'cancelled'],
]);

/**
 * Actions that set one of the workflow timestamps.
 */
const ACTIONS_WITH_TIMESTAMP: Record<EventLifecycleAction, 'submitted_for_review_at' | 'approved_at' | 'archived_at' | null> = {
  submit_for_review: 'submitted_for_review_at',
  approve: 'approved_at',
  archive: 'archived_at',
  reject: null,
  publish: null,
  unpublish: null,
  hide: null,
  show: null,
  restore: null,
  cancel: null,
};

interface WorkflowPatch {
  submitted_for_review_at?: string | null;
  approved_at?: string | null;
  approved_by?: number | null;
  archived_at?: string | null;
}

interface TransitionResult {
  event: EventRow;
  history: EventStatusHistoryRow;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class EventLifecycleService {
  /**
   * Apply a state transition + persist the resulting history row in a
   * single transaction.
   * @param organizationId - If provided, the event's organization_id must match.
   *   Pass null for super_admin (no org filter). Pass a number for org-scoped admin.
   */
  async transition(
    eventId: number,
    input: EventStatusTransitionInput,
    actor: { adminId: number | null; ip?: string | null; userAgent?: string | null },
    organizationId?: number | null
  ): Promise<TransitionResult> {
    if (!input.action) {
      throw new AppError('Action is required', 400);
    }

    return withTransaction(async (client) => {
      // Read with FOR UPDATE so concurrent transitions on the same event
      // are serialized. Prevents TOCTOU between status check and update.
      const current = await eventRepository.lockEventById(eventId, client);
      if (!current) {
        throw new AppError(`Event ${eventId} not found`, 404);
      }

      // Defense-in-depth: verify organization ownership
      if (organizationId !== undefined && organizationId !== null) {
        if (current.organization_id !== organizationId) {
          throw new AppError('Not authorized for this event', 403);
        }
      }

      const fromStatus = current.status;
      const key = `${fromStatus}:${input.action}`;
      const toStatus = TRANSITIONS.get(key);

      if (!toStatus) {
        throw new AppError(
          `Invalid transition: cannot "${input.action}" an event in status "${fromStatus}"`,
          409
        );
      }

      // 1) Update status
      const updated = await eventRepository.updateStatus(eventId, toStatus, client);
      if (!updated) {
        throw new AppError(`Event ${eventId} disappeared mid-transaction`, 500);
      }

      // 2) Apply side-effect timestamps when applicable
      const workflowPatch: WorkflowPatch = {};
      const timestampCol = ACTIONS_WITH_TIMESTAMP[input.action];
      if (timestampCol) {
        workflowPatch[timestampCol] = new Date().toISOString();
      }
      // approve: also stamp approved_by
      if (input.action === 'approve') {
        workflowPatch.approved_by = actor.adminId ?? null;
      }
      // restore: clear archived_at
      if (input.action === 'restore') {
        workflowPatch.archived_at = null;
      }

      if (Object.keys(workflowPatch).length > 0) {
        await eventRepository.updateWorkflowInfo(eventId, workflowPatch, client);
      }

      // 3) Append history row
      const metadata: Record<string, unknown> = {};
      if (actor.ip) metadata['ip'] = actor.ip;
      if (actor.userAgent) metadata['user_agent'] = actor.userAgent;

      const history = await eventRepository.insertStatusHistory(
        {
          eventId,
          actorAdminId: actor.adminId ?? null,
          fromStatus,
          toStatus,
          reason: input.reason ?? null,
          metadata,
        },
        client
      );

      logger.info(
        `Event ${eventId} ${fromStatus} → ${toStatus} (action=${input.action}, actor=${actor.adminId ?? 'system'})`
      );

      // Re-read the event so the response reflects the final state
      const finalEvent = await eventRepository.getEventById(eventId);
      return { event: finalEvent ?? updated, history };
    });
  }

  /**
   * Convenience helpers for each transition (used by the controller).
   */
  async submitForReview(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'submit_for_review', reason: reason ?? null }, actor, organizationId);
  }

  async approveEvent(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'approve', reason: reason ?? null }, actor, organizationId);
  }

  async rejectEvent(eventId: number, actor: { adminId: number | null }, reason: string, organizationId?: number | null) {
    if (!reason || !reason.trim()) {
      throw new AppError('A rejection reason is required', 400);
    }
    return this.transition(eventId, { action: 'reject', reason }, actor, organizationId);
  }

  async publishEvent(eventId: number, actor: { adminId: number | null }, organizationId?: number | null) {
    return this.transition(eventId, { action: 'publish' }, actor, organizationId);
  }

  async unpublishEvent(eventId: number, actor: { adminId: number | null }, organizationId?: number | null) {
    return this.transition(eventId, { action: 'unpublish' }, actor, organizationId);
  }

  async hideEvent(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'hide', reason: reason ?? null }, actor, organizationId);
  }

  async showEvent(eventId: number, actor: { adminId: number | null }, organizationId?: number | null) {
    return this.transition(eventId, { action: 'show' }, actor, organizationId);
  }

  async archiveEvent(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'archive', reason: reason ?? null }, actor, organizationId);
  }

  async restoreEvent(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'restore', reason: reason ?? null }, actor, organizationId);
  }

  async cancelEvent(eventId: number, actor: { adminId: number | null }, reason?: string | null, organizationId?: number | null) {
    return this.transition(eventId, { action: 'cancel', reason: reason ?? null }, actor, organizationId);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Return the unified history for an event, joined with the admin's
   * display name when the actor is an admin (NULL for system actions).
   */
  async getHistory(eventId: number): Promise<EventStatusHistoryPublic[]> {
    const { getPool } = await import('../db/pool');
    const result = await getPool().query(
      `SELECT h.id, h.event_id, h.actor_admin_id, a.name AS actor_name,
              h.from_status, h.to_status, h.reason, h.created_at
         FROM event_status_history h
         LEFT JOIN admins a ON a.id = h.actor_admin_id
        WHERE h.event_id = $1
        ORDER BY h.created_at DESC
        LIMIT 200`,
      [eventId]
    );
    return result.rows as unknown as EventStatusHistoryPublic[];
  }

  /**
   * Returns the list of actions valid from the event's current status.
   * Useful to power the UI's "what can I do next?" buttons.
   */
  getAllowedActions(currentStatus: EventStatus): EventLifecycleAction[] {
    const allowed: EventLifecycleAction[] = [];
    for (const key of TRANSITIONS.keys()) {
      const [s, action] = key.split(':', 2);
      if (s === currentStatus) allowed.push(action as EventLifecycleAction);
    }
    return allowed;
  }
}

export const eventLifecycleService = new EventLifecycleService();
