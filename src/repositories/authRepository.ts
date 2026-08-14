/**
 * Auth-related repository — login attempts, refresh tokens,
 * email verification, device sessions.
 *
 * Pattern: one repository per aggregate, same as userRepository.
 */

import { getPool, withTransaction } from '../db/pool';
import { hashPassword, comparePassword } from '../utils/crypto';
import type {
  LoginAttemptRow,
  RefreshTokenRow,
  VerificationTokenRow,
  UserSessionRow,
  PendingRegistrationRow,
} from '../types';
import { v4 as uuidv4 } from 'uuid';

function rowToNumber(row: { id?: number } | undefined): number {
  return row?.id ?? 0;
}

export class AuthRepository {
  // ── Login Attempts ──────────────────────────────────────────────────────

  async recordLoginAttempt(email: string, ipAddress: string, userAgent: string | null | undefined, success: boolean): Promise<void> {
    await getPool().query(
      `INSERT INTO login_attempts (email, ip_address, user_agent, success)
       VALUES ($1, $2, $3, $4)`,
      [email.toLowerCase().trim(), ipAddress, userAgent ?? null, success]
    );
  }

  async countRecentFailedAttempts(identifier: string, minutes: number = 15): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as count FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - INTERVAL '1 minute' * $2`,
      [identifier, minutes]
    );
    const row = rows as unknown as Array<{ count: number | string }>;
    const val = row[0]?.count ?? 0;
    return typeof val === 'string' ? parseInt(val, 10) : Number(val);
  }

  async countFailedAttemptsSince(identifier: string, sinceMinutes: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as count FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - (INTERVAL '1 minute' * $2)`,
      [identifier, sinceMinutes]
    );
    const row = rows as unknown as Array<{ count: number | string }>;
    const val = row[0]?.count ?? 0;
    return typeof val === 'string' ? parseInt(val, 10) : Number(val);
  }

  async getRecentFailureWindow(identifier: string): Promise<Date | null> {
    const { rows } = await getPool().query(
      `SELECT MIN(attempted_at) as earliest FROM login_attempts
       WHERE (email = $1 OR ip_address = $1)
         AND success = false
         AND attempted_at > NOW() - (INTERVAL '1 minute' * 60)
       LIMIT 1`,
      [identifier]
    );
    const row = rows as unknown as Array<{ earliest: string | null }>;
    return row[0]?.earliest ? new Date(row[0].earliest) : null;
  }

  async getRecentSuccessfulLogin(email: string): Promise<Date | null> {
    const { rows } = await getPool().query(
      `SELECT attempted_at FROM login_attempts
       WHERE email = $1 AND success = true
       ORDER BY attempted_at DESC LIMIT 1`,
      [email]
    );
    const row = rows as unknown as Array<{ attempted_at: string }>;
    return row[0]?.attempted_at ? new Date(row[0].attempted_at) : null;
  }

  // ── Refresh Tokens ──────────────────────────────────────────────────────

  async createRefreshToken(userId: number, tokenHash: string, sessionId: number | null, deviceInfo: string | null, ipAddress: string | null, expiresAt: string): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO refresh_tokens (user_id, token_hash, session_id, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, tokenHash, sessionId, deviceInfo, ipAddress, expiresAt]
    );
    return rowToNumber((rows as unknown as Array<{ id: number }>)[0]);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1',
      [tokenHash]
    );
    return (rows as unknown as RefreshTokenRow[])[0] || null;
  }

  /**
   * Atomically find-and-consume a refresh token in a single query.
   *
   * Returns the consumed row if the token was valid and unrevoked.
   * Returns null if the token was already revoked (concurrent rotation detected)
   * or doesn't exist.
   *
   * This replaces the separate findRefreshTokenByHash + rotateRefreshToken pattern
   * to eliminate the TOCTOU window where two concurrent requests could both pass
   * validation before either revokes the token.
   */
  async findAndConsumeRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    const { rows } = await getPool().query(
      `UPDATE refresh_tokens SET revoked = true
       WHERE token_hash = $1 AND revoked = false AND expires_at > NOW()
       RETURNING *`,
      [tokenHash]
    );
    return (rows as unknown as RefreshTokenRow[])[0] || null;
  }

  async revokeRefreshToken(tokenHash: string): Promise<boolean> {
    const result = await getPool().query(
      'UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1',
      [tokenHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomically revoke a refresh token ONLY if it is not already revoked.
   * Returns the number of rows updated (1 = success, 0 = already revoked).
   * This single UPDATE replaces the find-then-revoke pattern to prevent
   * TOCTOU race conditions during concurrent refresh attempts.
   */
  async rotateRefreshToken(tokenHash: string): Promise<boolean> {
    const result = await getPool().query(
      'UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1 AND revoked = false',
      [tokenHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async revokeAllUserRefreshTokens(userId: number): Promise<number> {
    const result = await getPool().query(
      'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false',
      [userId]
    );
    return result.rowCount ?? 0;
  }

  async revokeExpiredTokens(): Promise<number> {
    const result = await getPool().query(
      'UPDATE refresh_tokens SET revoked = true WHERE expires_at < NOW() AND revoked = false'
    );
    return result.rowCount ?? 0;
  }

  // ── Email Verification Tokens ───────────────────────────────────────────

  async createVerificationToken(userId: number, tokenHash: string, expiresAt: string, type = 'email_verification'): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO verification_tokens (user_id, token_hash, type, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, tokenHash, type, expiresAt]
    );
    return rowToNumber((rows as unknown as Array<{ id: number }>)[0]);
  }

  async findVerificationToken(tokenHash: string): Promise<VerificationTokenRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM verification_tokens WHERE token_hash = $1 AND used_at IS NULL LIMIT 1',
      [tokenHash]
    );
    return (rows as unknown as VerificationTokenRow[])[0] || null;
  }

  async markVerificationTokenUsed(tokenHash: string): Promise<boolean> {
    const result = await getPool().query(
      'UPDATE verification_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL',
      [tokenHash]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async invalidateUserVerificationTokens(userId: number): Promise<void> {
    await getPool().query(
      'UPDATE verification_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
      [userId]
    );
  }

  async markUserVerified(userId: number): Promise<void> {
    await getPool().query(
      'UPDATE users SET is_verified = true, email_verified_at = NOW() WHERE id = $1',
      [userId]
    );
  }

  // ── User Sessions ───────────────────────────────────────────────────────

  async createSession(userId: number, deviceInfo: string | null, ipAddress: string | null, userAgent: string | null, isCurrent = false): Promise<number> {
    const { rows } = await getPool().query(
      `INSERT INTO user_sessions (user_id, device_info, ip_address, user_agent, is_current)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, deviceInfo, ipAddress, userAgent, isCurrent]
    );
    return rowToNumber((rows as unknown as Array<{ id: number }>)[0]);
  }

  async revokeSession(sessionId: number): Promise<void> {
    await getPool().query('UPDATE user_sessions SET revoked = true WHERE id = $1', [sessionId]);
  }

  async revokeAllUserSessions(userId: number, exceptSessionId?: number): Promise<number> {
    let result;
    if (exceptSessionId) {
      result = await getPool().query(
        'UPDATE user_sessions SET revoked = true WHERE user_id = $1 AND id != $2 AND revoked = false',
        [userId, exceptSessionId]
      );
    } else {
      result = await getPool().query(
        'UPDATE user_sessions SET revoked = true WHERE user_id = $1 AND revoked = false',
        [userId]
      );
    }
    return result.rowCount ?? 0;
  }

  async getUserSessions(userId: number): Promise<UserSessionRow[]> {
    const { rows } = await getPool().query(
      'SELECT * FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return rows as unknown as UserSessionRow[];
  }

  // ── Pending Registrations (OTP) ───────────────────────────────────────────

  async createPendingRegistration(input: {
    email: string;
    username: string | null;
    passwordHash: string;
    otpHash: string;
    expiresAt: string;
  }): Promise<number> {
    // Use a transaction to atomically invalidate any existing unconsumed
    // row for this email and insert the new one.  The unique partial
    // index (email WHERE consumed_at IS NULL) guarantees only one active
    // row per email; the explicit invalidate makes the intent clear and
    // avoids "could not obtain exclusive lock" races under concurrency.
    return withTransaction(async (client) => {
      await client.query(
        `UPDATE pending_registrations SET consumed_at = NOW()
         WHERE email = $1 AND consumed_at IS NULL`,
        [input.email.toLowerCase().trim()]
      );
      const { rows } = await client.query(
        `INSERT INTO pending_registrations (email, username, password_hash, otp_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          input.email.toLowerCase().trim(),
          input.username?.trim() ?? null,
          input.passwordHash,
          input.otpHash,
          input.expiresAt,
        ]
      );
      return rowToNumber((rows as unknown as Array<{ id: number }>)[0]);
    });
  }

  async findPendingRegistrationByEmail(email: string): Promise<PendingRegistrationRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM pending_registrations WHERE email = $1 AND consumed_at IS NULL LIMIT 1',
      [email.toLowerCase().trim()]
    );
    return (rows as unknown as PendingRegistrationRow[])[0] || null;
  }

  async findPendingRegistrationByOtpHash(otpHash: string): Promise<PendingRegistrationRow | null> {
    const { rows } = await getPool().query(
      'SELECT * FROM pending_registrations WHERE otp_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() LIMIT 1',
      [otpHash]
    );
    return (rows as unknown as PendingRegistrationRow[])[0] || null;
  }

  async incrementPendingAttempts(id: number): Promise<void> {
    await getPool().query(
      'UPDATE pending_registrations SET otp_attempts = otp_attempts + 1 WHERE id = $1',
      [id]
    );
  }

  async markPendingConsumed(id: number): Promise<void> {
    await getPool().query(
      'UPDATE pending_registrations SET consumed_at = NOW() WHERE id = $1',
      [id]
    );
  }

  /**
   * Atomically mark a pending registration as consumed ONLY if it hasn't
   * already been consumed. Returns the consumed row if successful, null
   * if it was already consumed (concurrent verification detected).
   *
   * This replaces the separate verify-then-consume pattern to prevent
   * TOCTOU race conditions during concurrent OTP verification attempts.
   */
  async verifyAndConsumeOtp(id: number): Promise<boolean> {
    const result = await getPool().query(
      `UPDATE pending_registrations SET consumed_at = NOW()
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING id`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deletePendingRegistration(id: number): Promise<void> {
    await getPool().query('DELETE FROM pending_registrations WHERE id = $1', [id]);
  }

  async invalidateAllPendingForEmail(email: string): Promise<number> {
    const result = await getPool().query(
      'UPDATE pending_registrations SET consumed_at = NOW() WHERE email = $1 AND consumed_at IS NULL',
      [email.toLowerCase().trim()]
    );
    return result.rowCount ?? 0;
  }

  async cleanupExpiredPendingRegistrations(): Promise<number> {
    const result = await getPool().query(
      'DELETE FROM pending_registrations WHERE expires_at < NOW() OR consumed_at IS NOT NULL'
    );
    return result.rowCount ?? 0;
  }
}

export const authRepository = new AuthRepository();
