/**
 * Organizer user repository.
 */

import { getPool } from '../db/pool';
import { hashPassword, comparePassword } from '../utils/crypto';
import type { OrganizerUserRow, OrganizerUserPublic, OrganizerPasswordTokenRow, OrganizerUserCreateInput, OrganizerUserUpdateInput, OrganizerUserRole } from '../types';

export class OrganizerUserRepository {
  async findById(id: number): Promise<OrganizerUserRow | null> {
    const { rows } = await getPool().query('SELECT * FROM organizer_users WHERE id = $1 LIMIT 1', [id]);
    return (rows as unknown as OrganizerUserRow[])[0] || null;
  }

  async findByEmail(email: string): Promise<OrganizerUserRow | null> {
    const { rows } = await getPool().query('SELECT * FROM organizer_users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    return (rows as unknown as OrganizerUserRow[])[0] || null;
  }

  async findByEmailAndOrg(email: string, organizationId: number): Promise<OrganizerUserRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM organizer_users WHERE LOWER(email) = LOWER($1) AND organization_id = $2 LIMIT 1',
      [email, organizationId]
    );
    return (rows as unknown as OrganizerUserRow[])[0] || null;
  }

  async findByOrganization(organizationId: number): Promise<OrganizerUserRow[]> {
    const { rows } = await getPool().query('SELECT * FROM organizer_users WHERE organization_id = $1 ORDER BY role DESC, created_at ASC', [organizationId]);
    return rows as unknown as OrganizerUserRow[];
  }

  async listAll(query: { organizationId?: number; page?: number; pageSize?: number; search?: string; role?: OrganizerUserRole }): Promise<{ items: OrganizerUserPublic[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const page = query.page || 1;
    const pageSize = Math.min(query.pageSize || 25, 100);
    const offset = (page - 1) * pageSize;
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (query.organizationId) { whereClauses.push(`organization_id = $${idx++}`); params.push(query.organizationId); }
    if (query.role) { whereClauses.push(`role = $${idx++}`); params.push(query.role); }
    if (query.search) { params.push(`%${query.search}%`, `%${query.search}%`); whereClauses.push(`(email ILIKE $${idx++} OR name ILIKE $${idx - 1})`); }
    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const { rows: countRows } = await getPool().query(`SELECT COUNT(*) as total FROM organizer_users ${where}`, params);
    const total = Number((countRows as Array<{ total: number | string }>)[0]?.total ?? 0);
    const { rows } = await getPool().query(
      `SELECT id, organization_id, email, name, phone, role, permissions, is_active, must_change_password, last_login_at, created_at, updated_at FROM organizer_users ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    );
    return { items: rows as unknown as OrganizerUserPublic[], total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
  }

  async create(input: OrganizerUserCreateInput & { organization_id: number }): Promise<OrganizerUserRow> {
    const passwordHash = await hashPassword(input.password);
    const { rows } = await getPool().query(
      `INSERT INTO organizer_users (organization_id, email, password_hash, name, phone, role, permissions, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [input.organization_id, input.email.toLowerCase().trim(), passwordHash, input.name, input.phone ?? null, input.role, JSON.stringify(input.permissions || {})]
    );
    return (rows as unknown as OrganizerUserRow[])[0];
  }

  async update(id: number, input: OrganizerUserUpdateInput): Promise<OrganizerUserRow | null> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.email !== undefined) { fields.push(`email = $${idx++}`); params.push(input.email); }
    if (input.name !== undefined) { fields.push(`name = $${idx++}`); params.push(input.name); }
    if (input.phone !== undefined) { fields.push(`phone = $${idx++}`); params.push(input.phone); }
    if (input.role !== undefined) { fields.push(`role = $${idx++}`); params.push(input.role); }
    if (input.permissions !== undefined) { fields.push(`permissions = $${idx++}`); params.push(JSON.stringify(input.permissions)); }
    if (input.is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(input.is_active); }
    if (fields.length === 0) return this.findById(id);
    params.push(id);
    const { rows } = await getPool().query(`UPDATE organizer_users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return (rows as unknown as OrganizerUserRow[])[0] || null;
  }

  async setPassword(id: number, passwordHash: string, mustChange: boolean = false): Promise<void> {
    await getPool().query('UPDATE organizer_users SET password_hash = $2, must_change_password = $3 WHERE id = $1', [id, passwordHash, mustChange]);
  }

  async updateLastLogin(id: number): Promise<void> {
    await getPool().query('UPDATE organizer_users SET last_login_at = NOW() WHERE id = $1', [id]);
  }

  async recordFailedLogin(id: number): Promise<{ attempts: number; shouldLock: boolean }> {
    const { rows } = await getPool().query(
      `UPDATE organizer_users SET failed_login_attempts = failed_login_attempts + 1,
        locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END
       WHERE id = $1 RETURNING failed_login_attempts, locked_until`,
      [id]
    );
    const row = (rows as Array<{ failed_login_attempts: number; locked_until: string | null }>)[0];
    if (!row) return { attempts: 0, shouldLock: false };
    const shouldLock = row.locked_until !== null && new Date(row.locked_until) > new Date();
    return { attempts: row.failed_login_attempts, shouldLock };
  }

  async resetFailedLogin(id: number): Promise<void> {
    await getPool().query(
      'UPDATE organizer_users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
      [id]
    );
  }

  async verifyPassword(user: OrganizerUserRow, password: string): Promise<boolean> {
    return comparePassword(password, user.password_hash);
  }

  async delete(id: number): Promise<void> {
    await getPool().query('DELETE FROM organizer_users WHERE id = $1', [id]);
  }

  async anonymize(id: number): Promise<void> {
    await getPool().query(
      `UPDATE organizer_users SET name = $1, email = $2, phone = NULL, is_active = false, password_hash = 'deleted' WHERE id = $3`,
      [`[deleted-${id}]`, `deleted-${id}@removed.local`, id]
    );
  }
}

export const organizerUserRepository = new OrganizerUserRepository();
