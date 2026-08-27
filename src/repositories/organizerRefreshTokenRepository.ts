/**
 * Organizer refresh-token and session repository.
 *
 * Mirrors the user-side authRepository pattern so organizer tokens support:
 *   - Persistent storage (SHA-256 hashed, never plaintext)
 *   - Token rotation via atomic find-and-consume
 *   - Reuse detection triggers full revocation
 *   - Session tracking for per-device logout
 *   - Server-side revocation (immediate, no wait for JWT expiry)
 */

import { getPool } from '../db/pool';
import type {
  OrganizerRefreshTokenRow,
  OrganizerSessionRow,
} from '../types';

function rowToNumber(row: { id?: number } | undefined): number {
  return row?.id ?? 0;
}

export class OrganizerRefreshTokenRepository {
  // ── Refresh Tokens ────────────────────────────────────────────────────────

  async createRefreshToken(
    userId: number,
    tokenHash: string,
    sessionId: number | null,
    deviceInfo: string | null,
    ipAddress: string | null,
    expiresAt: string
  ): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO organizer_refresh_tokens
         (organizer_user_id, token_hash, session_id, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, tokenHash, sessionId, deviceInfo, ipAddress, expiresAt]
    );
    return rowToNumber((rows as Array<{ id: number }>)[0]);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<OrganizerRefreshTokenRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM organizer_refresh_tokens WHERE token_hash = $1 LIMIT 1',
      [tokenHash]
    );
    return (rows as OrganizerRefreshTokenRow[])[0] || null;
  }

  /**
   * Atomically find-and-consume a refresh token in a single query.
   * Returns the consumed row if valid; null if revoked/missing.
   * Eliminates TOCTOU race between validation and revocation.
   */
  async findAndConsumeRefreshToken(tokenHash: string): Promise<OrganizerRefreshTokenRow | null> {
    const { rows } = await getPool().query(
      `UPDATE organizer_refresh_tokens SET revoked = true
       WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()
       RETURNING *`,
      [tokenHash]
    );
    return (rows as OrganizerRefreshTokenRow[])[0] || null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<boolean> {
    const result = await getPool().query(
      'UPDATE organizer_refresh_tokens SET revoked = true WHERE token_hash = $1',
      [tokenHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeAllUserRefreshTokens(userId: number): Promise<number> {
    const result = await getPool().query(
      'UPDATE organizer_refresh_tokens SET revoked = true WHERE organizer_user_id = $1 AND revoked = false',
      [userId]
    );
    return result.rowCount ?? 0;
  }

  async revokeExpiredTokens(): Promise<number> {
    const result = await getPool().query(
      'UPDATE organizer_refresh_tokens SET revoked = true WHERE expires_at < NOW() AND revoked = false'
    );
    return result.rowCount ?? 0;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(
    userId: number,
    deviceInfo: string | null,
    ipAddress: string | null,
    userAgent: string | null,
    isCurrent = false
  ): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO organizer_sessions
         (organizer_user_id, device_info, ip_address, user_agent, is_current)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, deviceInfo, ipAddress, userAgent, isCurrent]
    );
    return rowToNumber((rows as Array<{ id: number }>)[0]);
  }

  async revokeSession(sessionId: number): Promise<void> {
    await getPool().query(
      'UPDATE organizer_sessions SET revoked = true WHERE id = $1',
      [sessionId]
    );
  }

  async revokeRefreshTokensBySessionId(sessionId: number): Promise<number> {
    const result = await getPool().query(
      'UPDATE organizer_refresh_tokens SET revoked = true WHERE session_id = $1 AND revoked = false',
      [sessionId]
    );
    return result.rowCount ?? 0;
  }

  async revokeAllUserSessions(userId: number, exceptSessionId?: number): Promise<number> {
    let result;
    if (exceptSessionId !== undefined) {
      result = await getPool().query(
        `UPDATE organizer_sessions SET revoked = true
         WHERE organizer_user_id = $1 AND id != $2 AND revoked = false`,
        [userId, exceptSessionId]
      );
    } else {
      result = await getPool().query(
        'UPDATE organizer_sessions SET revoked = true WHERE organizer_user_id = $1 AND revoked = false',
        [userId]
      );
    }
    return result.rowCount ?? 0;
  }

  async getUserSessions(userId: number): Promise<OrganizerSessionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM organizer_sessions WHERE organizer_user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows as OrganizerSessionRow[];
  }
}

export const organizerRefreshTokenRepository = new OrganizerRefreshTokenRepository();
