/**
 * Organizer password-token service.
 *
 * Handles one-time tokens for the initial owner-password-setup flow:
 *   1. Super Admin approves an organizer application (generates token)
 *   2. Approval persists a SHA-256 hash of the token + expiry
 *   3. Owner clicks the emailed link → POST /organizer/auth/setup-password
 *   4. Service looks up the hash, validates expiry, sets password, marks used
 */

import { getPool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { hashPassword } from '../utils/crypto';
import { generateSecureToken } from '../utils/safeToken';

const TOKEN_TTL_HOURS = 72;

export interface PasswordSetupTokenRow {
  id: number;
  organizer_user_id: number;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export class OrganizerPasswordTokenService {
  /**
   * Generate a one-time setup token and persist its hash.
   * Returns the raw token (to be emailed to the owner).
   */
  async generate(organizerUserId: number): Promise<string> {
    const raw = generateSecureToken(32);
    const tokenHash = await this._hash(raw);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

    await getPool().query(
      `INSERT INTO organizer_password_tokens (organizer_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [organizerUserId, tokenHash, expiresAt]
    );

    logger.info('Organizer password token generated', { organizerUserId });
    return raw;
  }

  /**
   * Consume a token: validate it, set the owner's password, mark token used.
   * Returns the organizer user id on success.
   */
  async consume(rawToken: string, newPassword: string): Promise<{ userId: number; email: string }> {
    const tokenHash = await this._hash(rawToken);

    // Atomic: atomically look up the token and mark it used in one query.
    // This eliminates the SELECT-then-UPDATE race condition where two
    // concurrent requests could both see the token as unused.
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE organizer_password_tokens
         SET used_at = NOW()
         WHERE token_hash = $1 AND used_at IS NULL
         RETURNING id, organizer_user_id, expires_at`,
        [tokenHash]
      );

      const tokenRow = (rows as PasswordSetupTokenRow[])[0];
      if (!tokenRow) {
        await client.query('ROLLBACK');
        throw new AppError('Invalid or already-used password setup link', 400);
      }

      if (new Date(tokenRow.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        throw new AppError('Password setup link has expired. Request a new one.', 400);
      }

      const passwordHash = await hashPassword(newPassword);

      // Fetch email before password change
      const { rows: userRows } = await client.query(
        `SELECT email FROM organizer_users WHERE id = $1`,
        [tokenRow.organizer_user_id]
      );
      const email = (userRows[0] as { email: string } | undefined)?.email || '';

      await client.query(
        `UPDATE organizer_users SET password_hash = $2, must_change_password = true WHERE id = $1`,
        [tokenRow.organizer_user_id, passwordHash]
      );

      await client.query('COMMIT');

      logger.info('Organizer password set via token', { organizerUserId: tokenRow.organizer_user_id });
      return { userId: tokenRow.organizer_user_id, email };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** SHA-256 hex digest */
  private async _hash(token: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export const organizerPasswordTokenService = new OrganizerPasswordTokenService();
