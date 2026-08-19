/**
 * SessionRepository — dedicated CRUD for user_sessions + admin_sessions.
 *
 * The original authRepository handled sessions inline; this dedicated
 * repository exposes independent session management (multi-device, revocation,
 * cleanup of stale sessions). Both user and admin sessions are handled.
 */

import { getPool } from '../db/pool';
import type { UserSessionRow, AdminSessionRow } from '../types';

export class SessionRepository {

  // ── User Sessions ───────────────────────────────────────────────────────────

  async createUserSession(input: {
    userId: number;
    deviceInfo?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<UserSessionRow> {
    const { rows } = await getPool().query(
      `INSERT INTO user_sessions (user_id, device_info, ip_address, user_agent, is_current, last_active_at)
       VALUES ($1, $2, $3, $4, false, NOW())
       RETURNING *`,
      [input.userId, input.deviceInfo ?? null, input.ipAddress ?? null, input.userAgent ?? null]
    );
    return rows[0] as unknown as UserSessionRow;
  }

  async findUserSessionById(id: number): Promise<UserSessionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM user_sessions WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as UserSessionRow[])[0] || null;
  }

  async findUserSessionsByUser(userId: number): Promise<UserSessionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY last_active_at DESC',
      [userId]
    );
    return rows as unknown as UserSessionRow[];
  }

  async findActiveUserSessions(userId: number): Promise<UserSessionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM user_sessions WHERE user_id = $1 AND revoked = false ORDER BY last_active_at DESC',
      [userId]
    );
    return rows as unknown as UserSessionRow[];
  }

  async updateLastActive(id: number): Promise<void> {
    await getPool().query(
      'UPDATE user_sessions SET last_active_at = NOW() WHERE id = $1',
      [id]
    );
  }

  async revokeUserSession(id: number): Promise<void> {
    await getPool().query(
      'UPDATE user_sessions SET revoked = true, is_current = false WHERE id = $1',
      [id]
    );
  }

  async revokeAllUserSessions(userId: number): Promise<number> {
    const { rowCount } = await getPool().query(
      'UPDATE user_sessions SET revoked = true, is_current = false WHERE user_id = $1',
      [userId]
    );
    return rowCount ?? 0;
  }

  async deleteRevokedUserSessions(userId: number): Promise<number> {
    const { rowCount } = await getPool().query(
      'DELETE FROM user_sessions WHERE user_id = $1 AND revoked = true',
      [userId]
    );
    return rowCount ?? 0;
  }

  // ── Admin Sessions ───────────────────────────────────────────────────────────

  async createAdminSession(input: {
    adminId: number;
    deviceInfo?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<AdminSessionRow> {
    const { rows } = await getPool().query(
      `INSERT INTO admin_sessions (admin_id, device_info, ip_address, user_agent, last_active_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING *`,
      [input.adminId, input.deviceInfo ?? null, input.ipAddress ?? null, input.userAgent ?? null]
    );
    return rows[0] as unknown as AdminSessionRow;
  }

  async findAdminSessionById(id: number): Promise<AdminSessionRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM admin_sessions WHERE id = $1 LIMIT 1',
      [id]
    );
    return (rows as AdminSessionRow[])[0] || null;
  }

  async findAdminSessionsByAdmin(adminId: number): Promise<AdminSessionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM admin_sessions WHERE admin_id = $1 ORDER BY last_active_at DESC',
      [adminId]
    );
    return rows as unknown as AdminSessionRow[];
  }

  async revokeAdminSession(id: number): Promise<void> {
    await getPool().query(
      'UPDATE admin_sessions SET revoked = true WHERE id = $1',
      [id]
    );
  }

  async revokeAllAdminSessions(adminId: number): Promise<number> {
    const { rowCount } = await getPool().query(
      'UPDATE admin_sessions SET revoked = true WHERE admin_id = $1',
      [adminId]
    );
    return rowCount ?? 0;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async deleteStaleSessions(maxAgeHours: number): Promise<{ users: number; admins: number }> {
    const hours = Math.max(1, Math.min(maxAgeHours, 168));
    const userResult = await getPool().query(
      `DELETE FROM user_sessions
       WHERE revoked = true AND last_active_at < NOW() - ($1 || ' hours')::INTERVAL`,
      [hours]
    );
    const adminResult = await getPool().query(
      `DELETE FROM admin_sessions
       WHERE revoked = true AND last_active_at < NOW() - ($1 || ' hours')::INTERVAL`,
      [hours]
    );
    return {
      users: userResult.rowCount ?? 0,
      admins: adminResult.rowCount ?? 0,
    };
  }

  async getUserSessionStats(userId: number): Promise<{
    total: number;
    active: number;
    revoked: number;
  }> {
    const { rows } = await getPool().query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE revoked = false)::int AS active,
         COUNT(*) FILTER (WHERE revoked = true)::int AS revoked
       FROM user_sessions WHERE user_id = $1`,
      [userId]
    );
    const row = (rows as Array<{ total: number; active: number; revoked: number }>)[0];
    return row || { total: 0, active: 0, revoked: 0 };
  }
}

export const sessionRepository = new SessionRepository();
export { sessionRepository as default };
