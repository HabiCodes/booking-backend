/**
 * Manager invitation repository — time-limited single-use invitations.
 */

import { getPool } from '../db/pool';
import { hashToken } from '../utils/safeToken';
import type { ManagerInvitationRow, ManagerInvitationPublic, ManagerInvitationCreateInput, ManagerInvitationTokenPayload } from '../types';

export class ManagerInvitationRepository {
  async create(input: ManagerInvitationCreateInput & { organizationId: number; invitedByUserId: number; rawToken: string }): Promise<ManagerInvitationRow> {
    const tokenHash = hashToken(input.rawToken);
    const expiresAt = new Date(Date.now() + (input.expires_in_hours || 72) * 60 * 60 * 1000).toISOString();
    const { rows } = await getPool().query(
      `INSERT INTO manager_invitations (organization_id, invited_by_user_id, email, name, token_hash, permissions, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.organizationId, input.invitedByUserId, input.email.toLowerCase().trim(), input.name || null, tokenHash, JSON.stringify(input.permissions || {}), expiresAt]
    );
    return rows[0] as unknown as ManagerInvitationRow;
  }

  async findByTokenHash(tokenHash: string): Promise<{ invitation: ManagerInvitationRow; organizationName: string } | null> {
    const { rows } = await getPool().query(
      `SELECT mi.*, o.name as organization_name FROM manager_invitations mi
       JOIN organizations o ON o.id = mi.organization_id
       WHERE mi.token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    if ((rows as unknown[]).length === 0) return null;
    return { invitation: rows[0] as unknown as ManagerInvitationRow, organizationName: (rows[0] as Record<string, unknown>).organization_name as string };
  }

  async findById(id: number): Promise<ManagerInvitationRow | null> {
    const { rows } = await getPool().query('SELECT * FROM manager_invitations WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as ManagerInvitationRow[])[0] || null;
  }

  async findByOrganization(organizationId: number, query: { page?: number; pageSize?: number }): Promise<{ items: ManagerInvitationPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const { rows: countRows } = await getPool().query('SELECT COUNT(*) as total FROM manager_invitations WHERE organization_id = $1', [organizationId]);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      'SELECT id, organization_id, email, name, permissions, expires_at, accepted_at, revoked_at, created_at, updated_at FROM manager_invitations WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [organizationId, pageSize, offset]
    );
    return { items: rows as unknown as ManagerInvitationPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async accept(id: number, userId: number): Promise<ManagerInvitationRow | null> {
    const { rows } = await getPool().query(
      `UPDATE manager_invitations SET accepted_at = NOW(), accepted_user_id = $1 WHERE id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING *`,
      [userId, id]
    );
    return (rows as unknown as ManagerInvitationRow[])[0] || null;
  }

  async revoke(id: number, revokedByUserId: number): Promise<ManagerInvitationRow | null> {
    const { rows } = await getPool().query(
      `UPDATE manager_invitations SET revoked_at = NOW(), revoked_by_user_id = $1 WHERE id = $2 AND accepted_at IS NULL RETURNING *`,
      [revokedByUserId, id]
    );
    return (rows as unknown as ManagerInvitationRow[])[0] || null;
  }

  async listValidForEmail(organizationId: number, email: string): Promise<ManagerInvitationRow[]> {
    const { rows } = await getPool().query(
      `SELECT * FROM manager_invitations WHERE organization_id = $1 AND email = LOWER($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
      [organizationId, email]
    );
    return rows as unknown as ManagerInvitationRow[];
  }
}

const managerInvitationRepository = new ManagerInvitationRepository();
export { managerInvitationRepository };
