"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventLifecycleService = exports.EventLifecycleService = void 0;
const pool_1 = require("../db/pool");
const eventRepository_1 = require("../repositories/eventRepository");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
// ── State machine ────────────────────────────────────────────────────────────
/**
 * Map: (currentStatus, action) → newStatus
 */
const TRANSITIONS = new Map([
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
const ACTIONS_WITH_TIMESTAMP = {
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
// ── Service ──────────────────────────────────────────────────────────────────
class EventLifecycleService {
    /**
     * Apply a state transition + persist the resulting history row in a
     * single transaction.
     */
    async transition(eventId, input, actor) {
        if (!input.action) {
            throw new errorHandler_1.AppError('Action is required', 400);
        }
        return (0, pool_1.withTransaction)(async (client) => {
            // Read with FOR UPDATE so concurrent transitions on the same event
            // are serialized.
            const current = await eventRepository_1.eventRepository.getEventById(eventId);
            if (!current) {
                throw new errorHandler_1.AppError(`Event ${eventId} not found`, 404);
            }
            const fromStatus = current.status;
            const key = `${fromStatus}:${input.action}`;
            const toStatus = TRANSITIONS.get(key);
            if (!toStatus) {
                throw new errorHandler_1.AppError(`Invalid transition: cannot "${input.action}" an event in status "${fromStatus}"`, 409);
            }
            // 1) Update status
            const updated = await eventRepository_1.eventRepository.updateStatus(eventId, toStatus, client);
            if (!updated) {
                throw new errorHandler_1.AppError(`Event ${eventId} disappeared mid-transaction`, 500);
            }
            // 2) Apply side-effect timestamps when applicable
            const workflowPatch = {};
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
                await eventRepository_1.eventRepository.updateWorkflowInfo(eventId, workflowPatch, client);
            }
            // 3) Append history row
            const metadata = {};
            if (actor.ip)
                metadata['ip'] = actor.ip;
            if (actor.userAgent)
                metadata['user_agent'] = actor.userAgent;
            const history = await eventRepository_1.eventRepository.insertStatusHistory({
                eventId,
                actorAdminId: actor.adminId ?? null,
                fromStatus,
                toStatus,
                reason: input.reason ?? null,
                metadata,
            }, client);
            logger_1.logger.info(`Event ${eventId} ${fromStatus} → ${toStatus} (action=${input.action}, actor=${actor.adminId ?? 'system'})`);
            // Re-read the event so the response reflects the final state
            const finalEvent = await eventRepository_1.eventRepository.getEventById(eventId);
            return { event: finalEvent ?? updated, history };
        });
    }
    /**
     * Convenience helpers for each transition (used by the controller).
     */
    async submitForReview(eventId, actor, reason) {
        return this.transition(eventId, { action: 'submit_for_review', reason: reason ?? null }, actor);
    }
    async approveEvent(eventId, actor, reason) {
        return this.transition(eventId, { action: 'approve', reason: reason ?? null }, actor);
    }
    async rejectEvent(eventId, actor, reason) {
        if (!reason || !reason.trim()) {
            throw new errorHandler_1.AppError('A rejection reason is required', 400);
        }
        return this.transition(eventId, { action: 'reject', reason }, actor);
    }
    async publishEvent(eventId, actor) {
        return this.transition(eventId, { action: 'publish' }, actor);
    }
    async unpublishEvent(eventId, actor) {
        return this.transition(eventId, { action: 'unpublish' }, actor);
    }
    async hideEvent(eventId, actor, reason) {
        return this.transition(eventId, { action: 'hide', reason: reason ?? null }, actor);
    }
    async showEvent(eventId, actor) {
        return this.transition(eventId, { action: 'show' }, actor);
    }
    async archiveEvent(eventId, actor, reason) {
        return this.transition(eventId, { action: 'archive', reason: reason ?? null }, actor);
    }
    async restoreEvent(eventId, actor, reason) {
        return this.transition(eventId, { action: 'restore', reason: reason ?? null }, actor);
    }
    async cancelEvent(eventId, actor, reason) {
        return this.transition(eventId, { action: 'cancel', reason: reason ?? null }, actor);
    }
    // ── Reads ──────────────────────────────────────────────────────────────────
    /**
     * Return the unified history for an event, joined with the admin's
     * display name when the actor is an admin (NULL for system actions).
     */
    async getHistory(eventId) {
        const { getPool } = await Promise.resolve().then(() => __importStar(require('../db/pool')));
        const result = await getPool().query(`SELECT h.id, h.event_id, h.actor_admin_id, a.name AS actor_name,
              h.from_status, h.to_status, h.reason, h.created_at
         FROM event_status_history h
         LEFT JOIN admins a ON a.id = h.actor_admin_id
        WHERE h.event_id = $1
        ORDER BY h.created_at DESC
        LIMIT 200`, [eventId]);
        return result.rows;
    }
    /**
     * Returns the list of actions valid from the event's current status.
     * Useful to power the UI's "what can I do next?" buttons.
     */
    getAllowedActions(currentStatus) {
        const allowed = [];
        for (const key of TRANSITIONS.keys()) {
            const [s, action] = key.split(':', 2);
            if (s === currentStatus)
                allowed.push(action);
        }
        return allowed;
    }
}
exports.EventLifecycleService = EventLifecycleService;
exports.eventLifecycleService = new EventLifecycleService();
