/**
 * OrganizerInvitationService — business logic for manager invitations.
 *
 * Flow:
 * 1. Owner creates invitation → token generated (SHA-256 hash stored)
 * 2. Plaintext token returned for email delivery (only once)
 * 3. User clicks link → token verified (constant-time comparison)
 * 4. User accepts → organizer_users row created
 * 5. Token marked as used
 *
 * Constraints:
 * - Only owners can create invitations
 * - Only one pending invitation per email per organization
 * - Managers can belong to only ONE organization (enforced by unique constraint)
 * - Invitations expire after configurable period (default 7 days)
 */

import { getPool } from '../db/pool';
import { organizerInvitationRepository } from '../repositories/organizerInvitationRepository';
import { organizationRepository } from '../repositories/organizationRepository';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import type {
  InvitationRow,
  InvitationStatus,
  InvitationPublic,
  InvitationCreateInput,
  OrganizerUserPublic,
} from '../types';

export class OrganizerInvitationService {

  /**
   * Create a new invitation for a manager.
   * Only organization owners can create invitations.
   */
  async createInvitation(
    inviterId: number,
    organizationId: number,
    input: InvitationCreateInput,
  ): Promise<{ invitation: InvitationPublic; plaintextToken: string }> {
    // Verify inviter is owner of this organization
    const inviter = await organizerUserRepository.findById(inviterId);
    if (!inviter || inviter.organization_id !== organizationId) {
      throw new Error('Unauthorized: You must be an owner of this organization');
    }
    if (inviter.role !== 'owner') {
      throw new Error('Forbidden: Only organization owners can send invitations');
    }

    // Check for existing pending invitation for this email
    const existing = await organizerInvitationRepository.findByOrganizationAndEmail(
      organizationId,
      input.email
    );
    if (existing) {
      throw new Error('A pending invitation already exists for this email');
    }

    // Check if user is already a member of this organization
    const existingUser = await organizerUserRepository.findByEmailAndOrg(input.email, organizationId);
    if (existingUser && existingUser.is_active) {
      throw new Error('This user is already a member of this organization');
    }

    // Check if user has a pending invitation for another organization
    const otherPending = await organizerInvitationRepository.findPendingByEmail(input.email);
    if (otherPending.length > 0) {
      throw new Error(
        'This email already has a pending invitation for another organization. ' +
        'A user can only belong to one organization at a time.'
      );
    }

    // Create the invitation
    const expiresInHours = input.expiresInHours || 168; // 7 days
    const result = await organizerInvitationRepository.create({
      organizationId,
      inviterId,
      email: input.email.toLowerCase().trim(),
      role: 'manager',
      message: input.message,
      expiresInHours,
    });

    return {
      invitation: this.toPublic(result.invitation),
      plaintextToken: result.plaintextToken,
    };
  }

  /**
   * Accept an invitation using the plaintext token.
   * Creates the organizer user account.
   */
  async acceptInvitation(
    tokenPlaintext: string,
    userData: {
      name: string;
      password: string;
    },
  ): Promise<OrganizerUserPublic> {
    // Find the invitation by token
    const invitation = await organizerInvitationRepository.findByToken(tokenPlaintext);
    if (!invitation) {
      throw new Error('Invalid or expired invitation token');
    }

    // Verify invitation is still pending
    if (invitation.status !== 'pending') {
      throw new Error('This invitation has already been used');
    }

    // Get organization details
    const organization = await organizationRepository.findById(invitation.organization_id);
    if (!organization || !organization.is_active) {
      throw new Error('This organization is no longer active');
    }

    // Check if email is already registered as a manager somewhere
    const existingUser = await organizerUserRepository.findByEmail(invitation.email);
    if (existingUser && existingUser.is_active) {
      // User already has an account — if it's in the same org, reject
      if (existingUser.organization_id === invitation.organization_id) {
        throw new Error('You are already a member of this organization');
      }
      // User is in another org — cannot join (single org constraint)
      throw new Error(
        'You are already a member of another organization. ' +
        'Contact your current organization owner to be removed before accepting this invitation.'
      );
    }

    // Create the organizer user (password is hashed internally)
    const user = await organizerUserRepository.create({
      organization_id: invitation.organization_id,
      email: invitation.email,
      name: userData.name,
      password: userData.password,
      role: 'manager',
      permissions: {
        movies_read: true,
        movies_write: false,
        cinemas_read: true,
        cinemas_write: false,
        showtimes_read: true,
        showtimes_write: false,
        price_caps_read: true,
        price_caps_write: false,
      },
    });

    // Mark invitation as used
    await organizerInvitationRepository.markUsed(invitation.id);

    // Log activity
    await this.logActivity(user.id, invitation.organization_id, 'invitation.accepted', 'invitation', invitation.id);

    return this.userToPublic(user);
  }

  /**
   * Revoke an invitation (owner only).
   */
  async revokeInvitation(
    invitationId: number,
    userId: number,
  ): Promise<void> {
    const invitation = await organizerInvitationRepository.findById(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    if (invitation.organization_id !== userId) {
      const inviter = await organizerUserRepository.findById(userId);
      if (!inviter || inviter.organization_id !== invitation.organization_id || inviter.role !== 'owner') {
        throw new Error('Forbidden: Only the organization owner can revoke invitations');
      }
    }

    const revoked = await organizerInvitationRepository.revoke(invitationId, userId);
    if (!revoked) {
      throw new Error('Invitation could not be revoked (may already be accepted or expired)');
    }
  }

  /**
   * List pending invitations for an organization.
   */
  async listPendingInvitations(
    organizationId: number,
    userId: number,
  ): Promise<InvitationPublic[]> {
    // Verify user belongs to this org
    const user = await organizerUserRepository.findById(userId);
    if (!user || user.organization_id !== organizationId) {
      throw new Error('Unauthorized: You do not have access to this organization');
    }

    const invitations = await organizerInvitationRepository.findPendingByOrganization(organizationId);
    return invitations.map(inv => this.toPublic(inv));
  }

  /**
   * Get a single invitation by ID.
   */
  async getInvitation(
    invitationId: number,
    userId: number,
  ): Promise<InvitationPublic> {
    const invitation = await organizerInvitationRepository.findById(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    const user = await organizerUserRepository.findById(userId);
    if (!user || user.organization_id !== invitation.organization_id) {
      throw new Error('Unauthorized');
    }

    return this.toPublic(invitation);
  }

  /**
   * Verify an invitation token (public endpoint - no auth required).
   * Returns minimal info to allow the accept flow.
   */
  async verifyInvitationToken(tokenPlaintext: string): Promise<{
    valid: boolean;
    email?: string;
    organizationName?: string;
    organizationDisplayName?: string;
    expiresAt?: string;
    error?: string;
  }> {
    const invitation = await organizerInvitationRepository.findByToken(tokenPlaintext);
    if (!invitation) {
      return { valid: false, error: 'Invalid or expired invitation token' };
    }

    if (invitation.status !== 'pending') {
      return { valid: false, error: 'This invitation has already been used' };
    }

    const organization = await organizationRepository.findById(invitation.organization_id);
    if (!organization) {
      return { valid: false, error: 'Organization no longer exists' };
    }

    return {
      valid: true,
      email: invitation.email,
      organizationName: organization.name,
      organizationDisplayName: organization.display_name,
      expiresAt: invitation.expires_at,
    };
  }

  /**
   * Resend an invitation (generates new token, invalidates old one).
   */
  async resendInvitation(
    invitationId: number,
    userId: number,
  ): Promise<{ invitation: InvitationPublic; plaintextToken: string }> {
    const invitation = await organizerInvitationRepository.findById(invitationId);
    if (!invitation) {
      throw new Error('Invitation not found');
    }

    // Verify requester is owner
    const user = await organizerUserRepository.findById(userId);
    if (!user || user.organization_id !== invitation.organization_id || user.role !== 'owner') {
      throw new Error('Forbidden: Only owners can resend invitations');
    }

    // Cancel old one
    await organizerInvitationRepository.cancel(invitationId, userId);

    // Create new one with same details
    const result = await organizerInvitationRepository.create({
      organizationId: invitation.organization_id,
      inviterId: userId,
      email: invitation.email,
      role: invitation.role,
      message: invitation.message || undefined,
      expiresInHours: 168,
    });

    return {
      invitation: this.toPublic(result.invitation),
      plaintextToken: result.plaintextToken,
    };
  }

  /**
   * Cleanup expired invitations. Should be called periodically.
   */
  async cleanupExpired(): Promise<number> {
    return organizerInvitationRepository.expireOld();
  }

  /**
   * Log organizer activity.
   */
  async logActivity(
    userId: number,
    organizationId: number,
    action: string,
    resourceType: string,
    resourceId: number | null,
    oldValues?: Record<string, unknown>,
    newValues?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await getPool().query(
        `INSERT INTO organizer_activity_log (organizer_user_id, organization_id, action, resource_type, resource_id, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, organizationId, action, resourceType, resourceId, oldValues ? JSON.stringify(oldValues) : null, newValues ? JSON.stringify(newValues) : null]
      );
    } catch {
      // Don't fail the main operation if logging fails
    }
  }

  // ── Mappers ─────────────────────────────────────────────────────────────────

  private toPublic(row: InvitationRow): InvitationPublic {
    return {
      id: row.id,
      organizationId: row.organization_id,
      inviterId: row.inviter_id,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at || undefined,
      usedAt: row.used_at || undefined,
      message: row.message || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private userToPublic(row: { id: number; organization_id: number; email: string; name: string; phone: string | null; role: string; permissions: Record<string, boolean>; is_active: boolean; last_login_at: string | null; created_at: string; updated_at: string }): OrganizerUserPublic {
    return {
      id: row.id,
      organization_id: row.organization_id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role as 'owner' | 'manager',
      permissions: row.permissions,
      is_active: row.is_active,
      last_login_at: row.last_login_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export const organizerInvitationService = new OrganizerInvitationService();