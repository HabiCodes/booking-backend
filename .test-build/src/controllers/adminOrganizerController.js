"use strict";
/**
 * Super Admin Organizer Management Controller
 *
 * Provides endpoints for:
 *  - List/search/filter organizer applications
 *  - View application details with history
 *  - Approve / soft-reject / hard-reject / reopen applications
 *  - List all organizations
 *  - List managers across organizations
 *
 * All endpoints require super_admin role or organizer:applications:* permissions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminOrganizerController = void 0;
exports.listOrganizerApplications = listOrganizerApplications;
exports.getOrganizerApplication = getOrganizerApplication;
exports.reviewOrganizerApplication = reviewOrganizerApplication;
exports.listOrganizations = listOrganizations;
exports.getOrganization = getOrganization;
exports.updateOrganization = updateOrganization;
exports.deactivateOrganization = deactivateOrganization;
exports.reactivateOrganization = reactivateOrganization;
exports.listManagers = listManagers;
exports.getManager = getManager;
exports.createManager = createManager;
exports.updateManager = updateManager;
exports.deactivateManager = deactivateManager;
exports.reactivateManager = reactivateManager;
const organizerApplicationService_1 = require("../services/organizerApplicationService");
const organizationRepository_1 = require("../repositories/organizationRepository");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
const errorHandler_1 = require("../middleware/errorHandler");
// ── Organizer Applications ────────────────────────────────────────────────────
async function listOrganizerApplications(req, res, next) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 100);
        const status = req.query.status;
        const search = req.query.search;
        const result = await organizerApplicationService_1.organizerApplicationService.listApplications({
            status,
            page,
            pageSize,
            search,
        });
        res.json({ success: true, ...result });
    }
    catch (err) {
        next(err);
    }
}
async function getOrganizerApplication(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const result = await organizerApplicationService_1.organizerApplicationService.getApplicationWithHistory(id);
        if (!result)
            throw new errorHandler_1.AppError('Application not found', 404);
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
async function reviewOrganizerApplication(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const { action, reason } = req.body;
        if (!['approve', 'soft_reject', 'hard_reject', 'reopen'].includes(action)) {
            throw new errorHandler_1.AppError('Invalid action. Use: approve, soft_reject, hard_reject, reopen', 400);
        }
        const actor = { adminId: req.admin.id, name: req.admin.email };
        let result;
        switch (action) {
            case 'approve':
                result = await organizerApplicationService_1.organizerApplicationService.approve(id, actor, reason);
                break;
            case 'soft_reject':
                if (!reason?.trim())
                    throw new errorHandler_1.AppError('Reason is required for soft rejection', 400);
                result = await organizerApplicationService_1.organizerApplicationService.softReject(id, { action: 'soft_reject', reason: reason.trim() }, actor);
                break;
            case 'hard_reject':
                if (!reason?.trim())
                    throw new errorHandler_1.AppError('Reason is required for hard rejection', 400);
                result = await organizerApplicationService_1.organizerApplicationService.hardReject(id, { action: 'hard_reject', reason: reason.trim() }, actor);
                break;
            case 'reopen':
                result = await organizerApplicationService_1.organizerApplicationService.reopen(id, actor, reason);
                break;
        }
        res.json({ success: true, data: result });
    }
    catch (err) {
        next(err);
    }
}
// ── Organizations ─────────────────────────────────────────────────────────────
async function listOrganizations(req, res, next) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 100);
        const search = req.query.search;
        const isActive = req.query.is_active !== 'false';
        const result = await organizationRepository_1.organizationRepository.findAll({ page, pageSize, search, isActive });
        res.json({ success: true, data: result.items, pagination: result });
    }
    catch (err) {
        next(err);
    }
}
async function getOrganization(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const org = await organizationRepository_1.organizationRepository.findById(id);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        // Include managers
        const managers = await organizerUserRepository_1.organizerUserRepository.findByOrganization(id);
        res.json({ success: true, data: { ...org, managers } });
    }
    catch (err) {
        next(err);
    }
}
async function updateOrganization(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const updates = req.body;
        const org = await organizationRepository_1.organizationRepository.update(id, updates);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        res.json({ success: true, data: org });
    }
    catch (err) {
        next(err);
    }
}
async function deactivateOrganization(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await organizationRepository_1.organizationRepository.deactivate(id);
        res.json({ success: true, message: 'Organization deactivated' });
    }
    catch (err) {
        next(err);
    }
}
async function reactivateOrganization(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await organizationRepository_1.organizationRepository.reactivate(id);
        res.json({ success: true, message: 'Organization reactivated' });
    }
    catch (err) {
        next(err);
    }
}
// ── Managers (organizer users visible to Super Admin) ─────────────────────────
async function listManagers(req, res, next) {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const pageSize = Math.min(parseInt(req.query.pageSize || '25', 10), 100);
        const organizationId = req.query.organization_id ? parseInt(req.query.organization_id, 10) : undefined;
        const search = req.query.search;
        const result = await organizerUserRepository_1.organizerUserRepository.listAll({ page, pageSize, organizationId, search });
        res.json({ success: true, data: result.items, pagination: result });
    }
    catch (err) {
        next(err);
    }
}
async function getManager(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const user = await organizerUserRepository_1.organizerUserRepository.findById(id);
        if (!user)
            throw new errorHandler_1.AppError('Manager not found', 404);
        const { password_hash: _, ...safe } = user;
        res.json({ success: true, data: safe });
    }
    catch (err) {
        next(err);
    }
}
async function createManager(req, res, next) {
    try {
        const { organization_id, email, name, phone, role, permissions } = req.body;
        if (!organization_id || !email || !name) {
            throw new errorHandler_1.AppError('organization_id, email, and name are required', 400);
        }
        const tempPassword = generateTempPassword();
        const user = await organizerUserRepository_1.organizerUserRepository.create({
            organization_id,
            email,
            name,
            phone: phone ?? null,
            password: tempPassword,
            role: role || 'manager',
            permissions: permissions || {},
        });
        const { password_hash: _, ...safe } = user;
        res.status(201).json({ success: true, data: safe, temp_password: tempPassword });
    }
    catch (err) {
        next(err);
    }
}
async function updateManager(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const updates = req.body;
        if (updates.password) {
            throw new errorHandler_1.AppError('Use the password reset endpoint to change passwords', 400);
        }
        const user = await organizerUserRepository_1.organizerUserRepository.update(id, updates);
        if (!user)
            throw new errorHandler_1.AppError('Manager not found', 404);
        const { password_hash: _, ...safe } = user;
        res.json({ success: true, data: safe });
    }
    catch (err) {
        next(err);
    }
}
async function deactivateManager(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await organizerUserRepository_1.organizerUserRepository.update(id, { is_active: false });
        res.json({ success: true, message: 'Manager deactivated' });
    }
    catch (err) {
        next(err);
    }
}
async function reactivateManager(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        await organizerUserRepository_1.organizerUserRepository.update(id, { is_active: true });
        res.json({ success: true, message: 'Manager reactivated' });
    }
    catch (err) {
        next(err);
    }
}
exports.adminOrganizerController = {
    listOrganizerApplications,
    getOrganizerApplication,
    reviewOrganizerApplication,
    listOrganizations,
    getOrganization,
    updateOrganization,
    deactivateOrganization,
    reactivateOrganization,
    listManagers,
    getManager,
    createManager,
    updateManager,
    deactivateManager,
    reactivateManager,
};
// ── Helpers ───────────────────────────────────────────────────────────────────
function generateTempPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => chars[b % chars.length]).join('');
}
