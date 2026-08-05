import { getPool } from '../db/pool';
import { UserRow, UserPublic } from '../types';
import { hashPassword, comparePassword } from '../utils/crypto';

export class UserRepository {
  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await getPool().query(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );
    return (rows as unknown as UserRow[])[0] || null;
  }

  async findById(id: number): Promise<UserPublic | null> {
    const { rows } = await getPool().query(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [id]
    );
    return (rows as unknown as UserPublic[])[0] || null;
  }

  async create(email: string, password: string): Promise<number> {
    const passwordHash = await hashPassword(password);
    const { rows } = await getPool().query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email.toLowerCase().trim(), passwordHash]
    );
    const result = (rows as unknown as Array<{ id: number }>)[0];
    return result?.id ?? 0;
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return comparePassword(password, hash);
  }

  async getUserTicketCount(userId: number, eventId: number): Promise<number> {
    const { rows } = await getPool().query(
      `SELECT COUNT(*) as total FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       WHERE b.user_id = $1 AND b.event_id = $2`,
      [userId, eventId]
    );
    const row = rows as Array<{ total: number | string }>;
    const total = row[0]?.total ?? 0;
    return typeof total === 'string' ? parseInt(total, 10) : Number(total);
  }
}

export const userRepository = new UserRepository();
