"use strict";
/**
 * Organizer Application Service — approval, soft/hard rejection, resubmission,
 * provisioning, and history tracking.
 *
 * Lifecycle:
 *   pending → approved    (provision org + owner account)
 *   pending → soft_rejected → pending    (resubmit)
 *   pending → hard_rejected → (locked, Super Admin reopen)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerApplicationService = exports.OrganizerApplicationService = void 0;
const safeToken_1 = require("../utils/safeToken");
const errorHandler_1 = require("../middleware/errorHandler");
const logger_1 = require("../utils/logger");
const pool_1 = require("../db/pool");
const organizerAppRepository_1 = require("../repositories/organizerAppRepository");
const organizationRepository_1 = require("../repositories/organizationRepository");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
const organizerPasswordTokenService_1 = require("./organizerPasswordTokenService");
// ── Default manager permissions ───────────────────────────────────────────────
const DEFAULT_MANAGER_PERMISSIONS = {
    'events:read': true,
    'bookings:read': true,
    'venues:read': true,
    'tiers:read': true,
    'seats:read': true,
    'tickets:scan': true,
    'tickets:checkin': true,
};
// ── Service ───────────────────────────────────────────────────────────────────
class OrganizerApplicationService {
    /**
     * Approve an organizer application — creates organization + owner user,
     * sends password-setup token.
     */
    async approve(applicationId, actor, reason) {
        const app = await organizerAppRepository_1.organizerAppRepository.findById(applicationId);
        if (!app)
            throw new errorHandler_1.AppError('Application not found', 404);
        if (app.status !== 'pending' && app.status !== 'soft_rejected') {
            throw new errorHandler_1.AppError(`Cannot approve application in status: ${app.status}`, 409);
        }
        return (0, pool_1.withTransaction)(async () => {
            // 1) Provision organization
            const slug = this._generateSlug(app.display_name);
            const organization = await organizationRepository_1.organizationRepository.create({
                name: app.legal_name,
                display_name: app.display_name,
                slug,
                email: app.email,
                phone: app.phone,
                address: app.business_address,
                city: app.city,
                state: app.state,
                country: app.country,
                logo_url: app.logo_url,
                description: app.description,
                branding_metadata: app.branding_metadata,
                bank_details: app.bank_details,
                payout_details: app.payout_details,
                application_id: app.id,
            });
            // 2) Create owner user with a random password (must change on first login)
            const tempPassword = (0, safeToken_1.generateSecureToken)(16);
            const owner = await organizerUserRepository_1.organizerUserRepository.create({
                organization_id: organization.id,
                email: app.email,
                name: app.display_name,
                phone: app.phone,
                password: tempPassword,
                role: 'owner',
                permissions: {},
            });
            // 3) Update application
            await organizerAppRepository_1.organizerAppRepository.update(app.id, {
                status: 'approved',
                organization_id: organization.id,
                reviewed_by: actor.adminId,
                reviewed_at: new Date().toISOString(),
                rejection_type: null,
                rejection_reason: null,
                hard_rejected_by: null,
                hard_rejected_at: null,
            });
            // 4) Record history
            const history = await organizerAppRepository_1.organizerAppRepository.addHistory({
                applicationId: app.id,
                from_status: app.status,
                to_status: 'approved',
                reason: reason || 'Application approved',
                actor_admin_id: actor.adminId,
                metadata: { organization_id: organization.id, owner_user_id: owner.id },
            });
            logger_1.logger.info('Organizer application approved', {
                applicationId, organizationId: organization.id, ownerId: owner.id, adminId: actor.adminId,
            });
            // 5) Generate password-setup token (persisted as SHA-256 hash)
            const passwordTokenRaw = await organizerPasswordTokenService_1.organizerPasswordTokenService.generate(owner.id);
            return {
                application: { ...app, status: 'approved', organization_id: organization.id },
                history,
                organization,
                owner: this._sanitizeUser(owner),
                passwordToken: passwordTokenRaw,
            };
        });
    }
    /**
     * Soft reject — organizer can edit and resubmit.
     */
    async softReject(applicationId, input, actor) {
        const app = await organizerAppRepository_1.organizerAppRepository.findById(applicationId);
        if (!app)
            throw new errorHandler_1.AppError('Application not found', 404);
        if (app.status !== 'pending') {
            throw new errorHandler_1.AppError(`Cannot soft-reject application in status: ${app.status}`, 409);
        }
        await organizerAppRepository_1.organizerAppRepository.update(app.id, {
            status: 'soft_rejected',
            rejection_type: 'soft',
            rejection_reason: input.reason,
            reviewed_by: actor.adminId,
            reviewed_at: new Date().toISOString(),
        });
        const history = await organizerAppRepository_1.organizerAppRepository.addHistory({
            applicationId: app.id,
            from_status: 'pending',
            to_status: 'soft_rejected',
            reason: input.reason || 'Application requires corrections',
            actor_admin_id: actor.adminId,
            metadata: { rejection_type: 'soft' },
        });
        logger_1.logger.info('Organizer application soft rejected', { applicationId, adminId: actor.adminId });
        return { application: { ...app, status: 'soft_rejected' }, history };
    }
    /**
     * Hard reject — permanently locked, only Super Admin can reopen.
     */
    async hardReject(applicationId, input, actor) {
        const app = await organizerAppRepository_1.organizerAppRepository.findById(applicationId);
        if (!app)
            throw new errorHandler_1.AppError('Application not found', 404);
        if (app.status !== 'pending') {
            throw new errorHandler_1.AppError(`Cannot hard-reject application in status: ${app.status}`, 409);
        }
        await organizerAppRepository_1.organizerAppRepository.update(app.id, {
            status: 'hard_rejected',
            rejection_type: 'hard',
            rejection_reason: input.reason,
            reviewed_by: actor.adminId,
            reviewed_at: new Date().toISOString(),
            hard_rejected_by: actor.adminId,
            hard_rejected_at: new Date().toISOString(),
        });
        const history = await organizerAppRepository_1.organizerAppRepository.addHistory({
            applicationId: app.id,
            from_status: 'pending',
            to_status: 'hard_rejected',
            reason: input.reason || 'Application permanently rejected',
            actor_admin_id: actor.adminId,
            metadata: { rejection_type: 'hard' },
        });
        logger_1.logger.info('Organizer application hard rejected', { applicationId, adminId: actor.adminId });
        return { application: { ...app, status: 'hard_rejected' }, history };
    }
    /**
     * Reopen a hard-rejected application.
     */
    async reopen(applicationId, actor, reason) {
        const app = await organizerAppRepository_1.organizerAppRepository.findById(applicationId);
        if (!app)
            throw new errorHandler_1.AppError('Application not found', 404);
        if (app.status !== 'hard_rejected') {
            throw new errorHandler_1.AppError(`Cannot reopen application in status: ${app.status}. Only hard-rejected applications can be reopened.`, 409);
        }
        await organizerAppRepository_1.organizerAppRepository.update(app.id, {
            status: 'pending',
            rejection_type: null,
            rejection_reason: null,
            hard_rejected_by: null,
            hard_rejected_at: null,
            reviewed_by: null,
            reviewed_at: null,
        });
        const history = await organizerAppRepository_1.organizerAppRepository.addHistory({
            applicationId: app.id,
            from_status: 'hard_rejected',
            to_status: 'pending',
            reason: reason || 'Application reopened by Super Admin',
            actor_admin_id: actor.adminId,
            metadata: { action: 'reopen' },
        });
        logger_1.logger.info('Organizer application reopened', { applicationId, adminId: actor.adminId });
        return { application: { ...app, status: 'pending' }, history };
    }
    /**
     * Submit an application for review — creates or updates the application.
     */
    async submit(data, existingId) {
        if (existingId) {
            const existing = await organizerAppRepository_1.organizerAppRepository.findById(existingId);
            if (!existing)
                throw new errorHandler_1.AppError('Application not found', 404);
            if (existing.status === 'approved') {
                throw new errorHandler_1.AppError('Approved applications cannot be modified', 409);
            }
            if (existing.status === 'hard_rejected') {
                throw new errorHandler_1.AppError('Hard-rejected applications cannot be modified', 409);
            }
            const updated = await organizerAppRepository_1.organizerAppRepository.update(existing.id, {
                ...data,
                status: 'pending',
                submitted_at: new Date().toISOString(),
                rejection_type: null,
                rejection_reason: null,
                hard_rejected_by: null,
                hard_rejected_at: null,
                reviewed_by: null,
                reviewed_at: null,
                organization_id: null, // allow re-provisioning on re-approval
            });
            return { application: updated, isNew: false };
        }
        else {
            const created = await organizerAppRepository_1.organizerAppRepository.create({
                ...data,
                status: 'pending',
                submitted_at: new Date().toISOString(),
            });
            return { application: created, isNew: true };
        }
    }
    // ── Helpers ────────────────────────────────────────────────────────────────
    _generateSlug(name) {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const suffix = Math.random().toString(36).slice(2, 6);
        return `${base}-${suffix}`;
    }
    _sanitizeUser(user) {
        const { password_hash: _, ...safe } = user;
        return safe;
    }
    // ── Super Admin queries ────────────────────────────────────────────────────
    async listApplications(query) {
        return organizerAppRepository_1.organizerAppRepository.findAll({
            status: query.status,
            page: query.page || 1,
            pageSize: query.pageSize || 25,
            search: query.search,
        });
    }
    async getApplicationWithHistory(id) {
        return organizerAppRepository_1.organizerAppRepository.findWithHistory(id);
    }
}
exports.OrganizerApplicationService = OrganizerApplicationService;
exports.organizerApplicationService = new OrganizerApplicationService();
