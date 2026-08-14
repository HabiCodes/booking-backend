/**
 * User repository — backward compatible with existing code.
 * Migration 001 adds: username, is_verified, is_active, last_login_at, email_verified_at
 */

import { getPool } from '../db/pool';
import type { UserRow, UserPublic } from '../types';
import { comparePassword } from '../utils/crypto';

export interface CreateUserParams {
  email: string;
  username?: string;
  passwordHash: string;
}

export class UserRepository {
  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await getPool().query(
      `SELECT id, email, username, password_hash, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users WHERE email = $1 LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    return (rows as unknown as UserRow[])[0] || null;
  }

  async findByUsername(username: string): Promise<UserRow | null> {
    const { rows } = await getPool().query(
      `SELECT id, email, username, password_hash, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );
    return (rows as unknown as UserRow[])[0] || null;
  }

  async findById(id: number): Promise<UserPublic | null> {
    const { rows } = await getPool().query(
      `SELECT id, email, username, is_verified, is_active, created_at
       FROM users WHERE id = $1`,
      [id]
    );
    return (rows as unknown as UserPublic[])[0] || null;
  }

  /** Legacy: register with just email+password */
  async create(email: string, password: string): Promise<number> {
    const passwordHash = await this.hashPassword(password);
    const { rows } = await getPool().query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email.toLowerCase().trim(), passwordHash]
    );
    const result = (rows as unknown as Array<{ id: number }>)[0];
    return result?.id ?? 0;
  }

  /** New: register with username as well */
  async createWithUsername(email: string, username: string, passwordHash: string): Promise<number> {
    // Defensive: never store empty string as username — use NULL instead
    const safeUsername = username && username.trim() ? username.trim() : null;
    const { rows } = await getPool().query(
      'INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [email.toLowerCase().trim(), safeUsername, passwordHash]
    );
    const result = (rows as unknown as Array<{ id: number }>)[0];
    return result?.id ?? 0;
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return comparePassword(password, hash);
  }

  async hashPassword(password: string): Promise<string> {
    const bcrypt = await import('bcrypt');
    return bcrypt.hash(password, 12);
  }

  async updateLastLogin(id: number): Promise<void> {
    await getPool().query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
  }

  async setVerified(id: number): Promise<void> {
    await getPool().query(
      'UPDATE users SET is_verified = true, email_verified_at = NOW() WHERE id = $1',
      [id]
    );
  }

  async getUserTicketCount(userId: number, eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as total FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       WHERE b.user_id = $1 AND b.event_id = $2
         AND b.status IN ('confirmed','attended')
         AND t.deleted_at IS NULL AND b.deleted_at IS NULL`,
      [userId, eventId]
    );
    const row = rows as Array<{ total: number | string }>;
    const total = row[0]?.total ?? 0;
    return typeof total === 'string' ? parseInt(total, 10) : Number(total);
  }

  async list(limit: number, offset: number): Promise<UserPublic[]> {
    const { rows } = await getPool().query(
      `SELECT id, email, username, is_verified, is_active, created_at
       FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows as unknown as UserPublic[];
  }
}

export const userRepository = new UserRepository();
