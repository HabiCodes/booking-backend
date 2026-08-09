/**
 * Organizer organization service — tenant management.
 */

import { AppError } from '../middleware/errorHandler';
import { organizationRepository } from '../repositories/organizationRepository';
import { organizerAppRepository } from '../repositories/organizerAppRepository';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import type {
  OrganizationRow,
  OrganizationUpdateInput,
  OrganizationBankUpdateInput,
} from '../types';

export class OrganizerOrganizationService {
  async getOwnOrganization(requesterId: number): Promise<OrganizationRow> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester) throw new AppError('User not found', 404);
    const org = await organizationRepository.findById(requester.organization_id);
    if (!org) throw new AppError('Organization not found', 404);
    return org as OrganizationRow;
  }

  async getById(id: number, requesterId: number): Promise<OrganizationRow> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== id) throw new AppError('Forbidden', 403);
    const org = await organizationRepository.findById(id);
    if (!org) throw new AppError('Organization not found', 404);
    return org as OrganizationRow;
  }

  async update(id: number, input: OrganizationUpdateInput, requesterId: number): Promise<OrganizationRow> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== id) throw new AppError('Forbidden', 403);
    const org = await organizationRepository.findById(id);
    if (!org) throw new AppError('Organization not found', 404);
    const updated = await organizationRepository.update(id, input);
    if (!updated) throw new AppError('Organization not found', 404);
    return updated as OrganizationRow;
  }

  async updateBanking(id: number, input: OrganizationBankUpdateInput, requesterId: number): Promise<OrganizationRow> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== id) throw new AppError('Forbidden', 403);
    const org = await organizationRepository.findById(id);
    if (!org) throw new AppError('Organization not found', 404);
    const updated = await organizationRepository.updateBanking(id, input);
    if (!updated) throw new AppError('Organization not found', 404);
    return updated as OrganizationRow;
  }

  async deactivate(id: number, requesterId: number): Promise<void> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== id) throw new AppError('Forbidden', 403);
    await organizationRepository.deactivate(id);
  }

  async reactivate(id: number, requesterId: number): Promise<void> {
    const requester = await organizerUserRepository.findById(requesterId);
    if (!requester || requester.organization_id !== id) throw new AppError('Forbidden', 403);
    await organizationRepository.reactivate(id);
  }
}

// Singleton
const organizerOrganizationService = new OrganizerOrganizationService();
export { organizerOrganizationService };
