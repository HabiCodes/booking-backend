"use strict";
/**
 * Organizer organization service — tenant management.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerOrganizationService = exports.OrganizerOrganizationService = void 0;
const errorHandler_1 = require("../middleware/errorHandler");
const organizationRepository_1 = require("../repositories/organizationRepository");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
class OrganizerOrganizationService {
    async getOwnOrganization(requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester)
            throw new errorHandler_1.AppError('User not found', 404);
        const org = await organizationRepository_1.organizationRepository.findById(requester.organization_id);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        return org;
    }
    async getById(id, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        const org = await organizationRepository_1.organizationRepository.findById(id);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        return org;
    }
    async update(id, input, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        const org = await organizationRepository_1.organizationRepository.findById(id);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        const updated = await organizationRepository_1.organizationRepository.update(id, input);
        if (!updated)
            throw new errorHandler_1.AppError('Organization not found', 404);
        return updated;
    }
    async updateBanking(id, input, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        const org = await organizationRepository_1.organizationRepository.findById(id);
        if (!org)
            throw new errorHandler_1.AppError('Organization not found', 404);
        const updated = await organizationRepository_1.organizationRepository.updateBanking(id, input);
        if (!updated)
            throw new errorHandler_1.AppError('Organization not found', 404);
        return updated;
    }
    async deactivate(id, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        await organizationRepository_1.organizationRepository.deactivate(id);
    }
    async reactivate(id, requesterId) {
        const requester = await organizerUserRepository_1.organizerUserRepository.findById(requesterId);
        if (!requester || requester.organization_id !== id)
            throw new errorHandler_1.AppError('Forbidden', 403);
        await organizationRepository_1.organizationRepository.reactivate(id);
    }
}
exports.OrganizerOrganizationService = OrganizerOrganizationService;
// Singleton
const organizerOrganizationService = new OrganizerOrganizationService();
exports.organizerOrganizationService = organizerOrganizationService;
