/**
 * Organizer Application Service — approval, soft/hard rejection, resubmission,
 * provisioning, and history tracking.
 *
 * Lifecycle:
 *   pending → approved    (provision org + owner account)
 *   pending → soft_rejected → pending    (resubmit)
 *   pending → hard_rejected → (locked, Super Admin reopen)
 */

import { generateSecureToken } from '../utils/safeToken';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { withTransaction } from '../db/pool';
import type {
  OrganizerApplicationRow,
  OrganizerApplicationPublic,
  OrganizerAppStatus,
  OrganizerApplicationReviewInput,
  OrganizerApplicationHistoryRow,
  OrganizationRow,
  OrganizerUserRow,
  OrganizerUserPublic,
} from '../types';

import { organizerAppRepository } from '../repositories/organizerAppRepository';
import { organizationRepository } from '../repositories/organizationRepository';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { organizerPasswordTokenService } from './organizerPasswordTokenService';

// ── Default manager permissions ───────────────────────────────────────────────

const DEFAULT_MANAGER_PERMISSIONS: Record<string, boolean> = {
  'events:read': true,
  'bookings:read': true,
  'venues:read': true,
  'tiers:read': true,
  'seats:read': true,
  'tickets:scan': true,
  'tickets:checkin': true,
};

// ── Service ───────────────────────────────────────────────────────────────────

export class OrganizerApplicationService {
  /**
   * Approve an organizer application — creates organization + owner user,
   * sends password-setup token.
   */
  async approve(
    applicationId: number,
    actor: { adminId: number; name: string },
    reason?: string | null,
  ): Promise<{
    application: OrganizerApplicationRow;
    history: OrganizerApplicationHistoryRow;
    organization: OrganizationRow;
    owner: OrganizerUserPublic;
    passwordToken: string;
  }> {
    const app = await organizerAppRepository.findById(applicationId);
    if (!app) throw new AppError('Application not found', 404);
    if (app.status !== 'pending' && app.status !== 'soft_rejected') {
      throw new AppError(`Cannot approve application in status: ${app.status}`, 409);
    }

    return withTransaction(async () => {
      // 1) Provision organization
      const slug = this._generateSlug(app.display_name);
      const organization = await organizationRepository.create({
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
      const tempPassword = generateSecureToken(16);
      const owner = await organizerUserRepository.create({
        organization_id: organization.id,
        email: app.email,
        name: app.display_name,
        phone: app.phone,
        password: tempPassword,
        role: 'owner',
        permissions: {},
      });

      // 3) Update application
      await organizerAppRepository.update(app.id, {
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
      const history = await organizerAppRepository.addHistory({
        applicationId: app.id,
        from_status: app.status,
        to_status: 'approved',
        reason: reason || 'Application approved',
        actor_admin_id: actor.adminId,
        metadata: { organization_id: organization.id, owner_user_id: owner.id },
      });

      logger.info('Organizer application approved', {
        applicationId, organizationId: organization.id, ownerId: owner.id, adminId: actor.adminId,
      });

      // 5) Generate password-setup token (persisted as SHA-256 hash)
      const passwordTokenRaw = await organizerPasswordTokenService.generate(owner.id);

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
  async softReject(
    applicationId: number,
    input: OrganizerApplicationReviewInput,
    actor: { adminId: number; name: string },
  ): Promise<{ application: OrganizerApplicationRow; history: OrganizerApplicationHistoryRow }> {
    const app = await organizerAppRepository.findById(applicationId);
    if (!app) throw new AppError('Application not found', 404);
    if (app.status !== 'pending') {
      throw new AppError(`Cannot soft-reject application in status: ${app.status}`, 409);
    }

    await organizerAppRepository.update(app.id, {
      status: 'soft_rejected',
      rejection_type: 'soft',
      rejection_reason: input.reason,
      reviewed_by: actor.adminId,
      reviewed_at: new Date().toISOString(),
    });

    const history = await organizerAppRepository.addHistory({
      applicationId: app.id,
      from_status: 'pending',
      to_status: 'soft_rejected',
      reason: input.reason || 'Application requires corrections',
      actor_admin_id: actor.adminId,
      metadata: { rejection_type: 'soft' },
    });

    logger.info('Organizer application soft rejected', { applicationId, adminId: actor.adminId });
    return { application: { ...app, status: 'soft_rejected' } as OrganizerApplicationRow, history };
  }

  /**
   * Hard reject — permanently locked, only Super Admin can reopen.
   */
  async hardReject(
    applicationId: number,
    input: OrganizerApplicationReviewInput,
    actor: { adminId: number; name: string },
  ): Promise<{ application: OrganizerApplicationRow; history: OrganizerApplicationHistoryRow }> {
    const app = await organizerAppRepository.findById(applicationId);
    if (!app) throw new AppError('Application not found', 404);
    if (app.status !== 'pending') {
      throw new AppError(`Cannot hard-reject application in status: ${app.status}`, 409);
    }

    await organizerAppRepository.update(app.id, {
      status: 'hard_rejected',
      rejection_type: 'hard',
      rejection_reason: input.reason,
      reviewed_by: actor.adminId,
      reviewed_at: new Date().toISOString(),
      hard_rejected_by: actor.adminId,
      hard_rejected_at: new Date().toISOString(),
    });

    const history = await organizerAppRepository.addHistory({
      applicationId: app.id,
      from_status: 'pending',
      to_status: 'hard_rejected',
      reason: input.reason || 'Application permanently rejected',
      actor_admin_id: actor.adminId,
      metadata: { rejection_type: 'hard' },
    });

    logger.info('Organizer application hard rejected', { applicationId, adminId: actor.adminId });
    return { application: { ...app, status: 'hard_rejected' } as OrganizerApplicationRow, history };
  }

  /**
   * Reopen a hard-rejected application.
   */
  async reopen(
    applicationId: number,
    actor: { adminId: number; name: string },
    reason?: string | null,
  ): Promise<{ application: OrganizerApplicationRow; history: OrganizerApplicationHistoryRow }> {
    const app = await organizerAppRepository.findById(applicationId);
    if (!app) throw new AppError('Application not found', 404);
    if (app.status !== 'hard_rejected') {
      throw new AppError(`Cannot reopen application in status: ${app.status}. Only hard-rejected applications can be reopened.`, 409);
    }

    await organizerAppRepository.update(app.id, {
      status: 'pending',
      rejection_type: null,
      rejection_reason: null,
      hard_rejected_by: null,
      hard_rejected_at: null,
      reviewed_by: null,
      reviewed_at: null,
    });

    const history = await organizerAppRepository.addHistory({
      applicationId: app.id,
      from_status: 'hard_rejected',
      to_status: 'pending',
      reason: reason || 'Application reopened by Super Admin',
      actor_admin_id: actor.adminId,
      metadata: { action: 'reopen' },
    });

    logger.info('Organizer application reopened', { applicationId, adminId: actor.adminId });
    return { application: { ...app, status: 'pending' } as OrganizerApplicationRow, history };
  }

  /**
   * Submit an application for review — creates or updates the application.
   */
  async submit(data: Record<string, unknown>, existingId?: number): Promise<{ application: OrganizerApplicationRow; isNew: boolean }> {
    if (existingId) {
      const existing = await organizerAppRepository.findById(existingId);
      if (!existing) throw new AppError('Application not found', 404);
      if (existing.status === 'approved') {
        throw new AppError('Approved applications cannot be modified', 409);
      }
      if (existing.status === 'hard_rejected') {
        throw new AppError('Hard-rejected applications cannot be modified', 409);
      }

      const updated = await organizerAppRepository.update(existing.id, {
        ...data,
        status: 'pending',
        submitted_at: new Date().toISOString(),
        rejection_type: null,
        rejection_reason: null,
        hard_rejected_by: null,
        hard_rejected_at: null,
        reviewed_by: null,
        reviewed_at: null,
        organization_id: null,  // allow re-provisioning on re-approval
      } as Partial<OrganizerApplicationRow>);

      return { application: updated, isNew: false };
    } else {
      const created = await organizerAppRepository.create({
        ...data,
        status: 'pending',
        submitted_at: new Date().toISOString(),
      });
      return { application: created, isNew: true };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _generateSlug(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${base}-${suffix}`;
  }

  private _sanitizeUser(user: OrganizerUserRow): OrganizerUserPublic {
    const { password_hash: _, ...safe } = user as unknown as Record<string, unknown>;
    return safe as unknown as OrganizerUserPublic;
  }

  // ── Super Admin queries ────────────────────────────────────────────────────

  async listApplications(query: { status?: string; page?: number; pageSize?: number; search?: string }): Promise<{
    items: OrganizerApplicationPublic[]; total: number; page: number; pageSize: number; totalPages: number;
  }> {
    return organizerAppRepository.findAll({
      status: query.status as OrganizerAppStatus | undefined,
      page: query.page || 1,
      pageSize: query.pageSize || 25,
      search: query.search,
    });
  }

  async getApplicationWithHistory(id: number): Promise<{ application: OrganizerApplicationRow; history: OrganizerApplicationHistoryRow[] } | null> {
    return organizerAppRepository.findWithHistory(id);
  }
}

export const organizerApplicationService = new OrganizerApplicationService();
