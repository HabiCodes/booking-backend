import { comparePassword, hashPassword } from '../utils/crypto';
import { getPool } from '../db/pool';
import { generateAdminToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';

export class AdminService {
  async login(email: string, password: string) {
    const { rows } = await getPool().query(
      'SELECT id, email, password_hash, name FROM admins WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );

    const admin = (rows as unknown as Array<{
      id: number;
      email: string;
      password_hash: string;
      name: string;
    }>)[0];

    if (!admin) {
      throw new AppError('Invalid credentials', 401);
    }

    const valid = await comparePassword(password, admin.password_hash);
    if (!valid) {
      throw new AppError('Invalid credentials', 401);
    }

    const token = generateAdminToken(admin.id, admin.email);

    return {
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    };
  }

  async seed(email: string, password: string, name: string): Promise<{ created: boolean; adminId: number }> {
    const passwordHash = await hashPassword(password);

    const { rows: existingRows } = await getPool().query(
      'SELECT id FROM admins WHERE email = $1 LIMIT 1',
      [email.toLowerCase().trim()]
    );
    const found = (existingRows as unknown as Array<{ id: number }>)[0];

    if (found) {
      await getPool().query(
        'UPDATE admins SET password_hash = $1, name = $2 WHERE id = $3',
        [passwordHash, name, found.id]
      );
      return { created: false, adminId: found.id };
    }

    const { rows: inserted } = await getPool().query(
      'INSERT INTO admins (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id',
      [email.toLowerCase().trim(), passwordHash, name]
    );
    const adminId = (inserted as unknown as Array<{ id: number }>)[0]?.id ?? 0;
    return { created: true, adminId };
  }
}

export const adminService = new AdminService();
