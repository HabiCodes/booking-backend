/**
 * OrganizerInvitationRepository — token-based invitation management for organizations.
 *
 * Features:
 * - Cryptographically random tokens with SHA-256 hash storage
 * - Constant-time token comparison via crypto.timingSafeEqual
 * - One pending invitation per email per organization
 * - Invitation lifecycle: pending → accepted / expired / revoked / cancelled
 */

import { getPool } from '../db/pool';
import { randomBytes } from 'crypto';
import type { InvitationRow, InvitationPublic } from '../types';

export interface CreateInvitationInput {
  organizationId: number;
  inviterId: number;
  email: string;
  role?: string;
  message?: string;
  expiresInHours?: number;
  ipAddress?: string;
  userAgent?: string;
}

export interface InvitationListItem {
  id: number;
  organizationId: number;
  inviterId: number;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  acceptedAt?: string;
  usedAt?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export class OrganizerInvitationRepository {

  /**
   * Hash a plaintext token using SHA-256.
   */
  private hashToken(token: string): string {
    const { createHash } = require('crypto');
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Generate a cryptographically random invitation token.
   * Returns both the plaintext (for email) and hash (for storage).
   */
  generateToken(): { plaintext: string; hash: string } {
    const raw = randomBytes(32).toString('hex');
    return { plaintext: raw, hash: this.hashToken(raw) };
  }

  /**
   * Verify a plaintext token against a stored hash using constant-time comparison.
   */
  verifyToken(plaintext: string, hash: string): boolean {
    const { timingSafeEqual } = require('crypto');
    const inputHash = this.hashToken(plaintext);
    if (inputHash.length !== hash.length) return false;
    try {
      return timingSafeEqual(Buffer.from(inputHash), Buffer.from(hash));
    } catch {
      return false;
    }
  }

  /**
   * Create a new invitation.
   * Returns the invitation with the PLAINTEXT token (for email delivery).
   * The plaintext is only returned once — it is never stored or returned again.
   */
  async create(input: CreateInvitationInput): Promise<{ invitation: InvitationRow; plaintextToken: string }> {
    const expiresInHours = input.expiresInHours || 168; // 7 days default
    const { plaintext, hash } = this.generateToken();

    const { rows } = await getPool().query(
      `INSERT INTO organizer_invitations (organization_id, inviter_id, email, role, token_hash, expires_at, message, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,NOW() + $6::interval,$7,$8,$9)
       RETURNING *`,
      [
        input.organizationId,
        input.inviterId,
        input.email.toLowerCase().trim(),
        input.role || 'manager',
        hash,
        `${expiresInHours} hours`,
        input.message || null,
        input.ipAddress || null,
        input.userAgent || null,
      ]
    );

    return { invitation: rows[0] as InvitationRow, plaintextToken: plaintext };
  }

  async findById(id: number): Promise<InvitationRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM organizer_invitations WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as unknown as InvitationRow[])[0] || null;
  }

  /**
   * Find a pending invitation by its plaintext token.
   */
  async findByToken(plaintext: string): Promise<InvitationRow | null> {
    const hash = this.hashToken(plaintext);
    const { rows } = await getPool().query(
      `SELECT * FROM organizer_invitations WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW() LIMIT 1`,
      [hash]
    );
    if (!rows.length) return null;
    const row = rows[0] as InvitationRow;
    if (!this.verifyToken(plaintext, row.token_hash)) return null; // timing-safe guard
    return row;
  }

  /**
   * Find pending invitation for an email+organization.
   */
  async findByOrganizationAndEmail(organizationId: number, email: string): Promise<InvitationRow | null> {
    const { rows } = await getPool().query(
      `SELECT * FROM organizer_invitations WHERE organization_id = $1 AND email = $2 AND status = 'pending' LIMIT 1`,
      [organizationId, email.toLowerCase().trim()]
    );
    return (rows as unknown as InvitationRow[])[0] || null;
  }

  /**
   * Find all pending invitations for an organization.
   */
  async findPendingByOrganization(organizationId: number): Promise<InvitationRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM organizer_invitations
       WHERE organization_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [organizationId]
    );
    return rows as unknown as InvitationRow[];
  }

  /**
   * Find all invitations for an organization (all statuses).
   */
  async findAllByOrganization(organizationId: number, status?: string): Promise<InvitationRow[]> {
    let query = 'SELECT * FROM organizer_invitations WHERE organization_id = $1';
    const params: unknown[] = [organizationId];
    if (status) {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const { rows } = await getPool().query(query, params);
    return rows as unknown as InvitationRow[];
  }

  /**
   * Find all pending invitations for an email address across all organizations.
   * Used to check if a user has any pending invitations.
   */
  async findPendingByEmail(email: string): Promise<InvitationRow[]> {
    const { rows } = await getPool().query(
      `SELECT i.*, o.name as org_name, o.display_name as org_display_name
       FROM organizer_invitations i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.email = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [email.toLowerCase().trim()]
    );
    return rows as unknown as InvitationRow[];
  }

  /**
   * Accept an invitation — marks it as accepted.
   */
  async accept(id: number): Promise<InvitationRow | null> {
    const { rows } = await getPool().query(
      `UPDATE organizer_invitations
       SET status = 'accepted', accepted_at = NOW()
       WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
       RETURNING *`,
      [id]
    );
    return (rows as unknown as InvitationRow[])[0] || null;
  }

  /**
   * Revoke an invitation (before it's accepted).
   */
  async revoke(id: number, userId: number): Promise<boolean> {
    const { rows } = await getPool().query(
      `UPDATE organizer_invitations
       SET status = 'revoked', used_at = NOW()
       WHERE id = $1 AND status = 'pending' AND inviter_id = $2
       RETURNING id`,
      [id, userId]
    );
    return (rows as unknown[]).length > 0;
  }

  /**
   * Cancel an invitation (owner can cancel their own pending invite).
   */
  async cancel(id: number, userId: number): Promise<boolean> {
    const { rows } = await getPool().query(
      `UPDATE organizer_invitations
       SET status = 'cancelled', used_at = NOW()
       WHERE id = $1 AND status = 'pending' AND inviter_id = $2
       RETURNING id`,
      [id, userId]
    );
    return (rows as unknown[]).length > 0;
  }

  /**
   * Mark expired invitations. Call this periodically.
   */
  async expireOld(): Promise<number> {
    const { rows } = await getPool().query(
      `UPDATE organizer_invitations
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at < NOW()
       RETURNING id`,
      []
    );
    return (rows as unknown[]).length;
  }

  /**
   * Check if an email has any pending invitation for any organization.
   * Used to enforce "one organization per manager" rule.
   */
  async hasPendingInvitation(email: string): Promise<boolean> {
    const { rows } = await getPool().query(
      `SELECT 1 FROM organizer_invitations WHERE email = $1 AND status = 'pending' AND expires_at > NOW() LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    return (rows as unknown[]).length > 0;
  }

  /**
   * Count active managers in an organization.
   */
  async countManagers(organizationId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as count FROM organizer_users
       WHERE organization_id = $1 AND role = 'manager' AND is_active = true`,
      [organizationId]
    );
    return Number((rows as Array<{ count: number | string }>)[0]?.count ?? 0);
  }

  /**
   * Mark invitation as used (when the user accepts).
   */
  async markUsed(id: number): Promise<void> {
    await getPool().query(
      `UPDATE organizer_invitations
       SET status = 'accepted', accepted_at = NOW(), used_at = NOW()
       WHERE id = $1 AND status = 'pending'`,
      [id]
    );
  }
}

export const organizerInvitationRepository = new OrganizerInvitationRepository();