import { comparePassword, hashPassword } from '../utils/crypto';
import { getPool } from '../db/pool';
import { generateAdminAccessToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { computePermissions } from '../rbac/permissions';
import type { AdminRow, AdminRole } from '../types';

interface AdminRecord {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  role: AdminRole;
  is_active: boolean;
  last_login_at: string | null;
  permissions: Record<string, boolean>;
  permissions_updated_at: string | null;
}

function normalizePermissions(value: unknown): Record<string, boolean> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  }
  return {};
}

function rowToRecord(r: AdminRecord): AdminRecord {
  return {
    id: Number(r.id),
    email: String(r.email),
    password_hash: String(r.password_hash),
    name: String(r.name),
    role: r.role,
    is_active: Boolean(r.is_active),
    last_login_at: r.last_login_at,
    permissions: normalizePermissions(r.permissions),
    permissions_updated_at: r.permissions_updated_at ?? null,
  };
}

export class AdminService {
  /**
   * Authenticate an admin and issue a JWT carrying role + effective permissions.
   * Updates `last_login_at` opportunistically (failure here doesn't break login).
   */
  async login(email: string, password: string) {
    const { rows } = await getPool().query(
      `SELECT id, email, password_hash, name, role, is_active, last_login_at, permissions, permissions_updated_at
       FROM admins WHERE email = $1 LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    const admin = rowToRecord((rows as unknown as AdminRecord[])[0]);

    if (!admin) {
      throw new AppError('Invalid credentials', 401);
    }
    if (!admin.is_active) {
      throw new AppError('Account is disabled', 403);
    }

    const valid = await comparePassword(password, admin.password_hash);
    if (!valid) {
      throw new AppError('Invalid credentials', 401);
    }

    const effectivePermissions = computePermissions(admin.role, admin.permissions);
    const token = generateAdminAccessToken(admin.id, admin.email, admin.role, effectivePermissions, admin.permissions_updated_at);

    // best-effort last_login update
    try {
      await getPool().query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [admin.id]);
    } catch {
      // intentionally non-fatal
    }

    return {
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        permissions: effectivePermissions,
      },
    };
  }

  /**
   * Create or update a seed admin. Idempotent. Used by the seed script and the
   * boot-time seeding in `src/seed/admin.ts`.
   */
  async seed(
    email: string,
    password: string,
    name: string,
    role: AdminRole = 'admin'
  ): Promise<{ created: boolean; adminId: number }> {
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
      'INSERT INTO admins (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [email.toLowerCase().trim(), passwordHash, name, role]
    );
    const adminId = ((inserted as unknown as Array<{ id: number }>)[0]?.id) ?? 0;
    return { created: true, adminId };
  }

  // ── Listing / management (used by the Admin Dashboard) ─────────────────────

  async listAll(limit: number = 50, offset: number = 0): Promise<AdminRow[]> {
    const { rows } = await getPool().query(
      `SELECT id, email, name, role, is_active, last_login_at, permissions, permissions_updated_at, created_at
       FROM admins
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows as unknown as AdminRow[];
  }

  async findById(id: number): Promise<AdminRow | null> {
    const { rows } = await getPool().query(
      `SELECT id, email, name, role, is_active, last_login_at, permissions, permissions_updated_at, created_at
       FROM admins WHERE id = $1 LIMIT 1`,
      [id]
    );
    return (rows as unknown as AdminRow[])[0] ?? null;
  }

  async setActive(id: number, isActive: boolean): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'UPDATE admins SET is_active = $1 WHERE id = $2',
      [isActive, id]
    );
    return (rowCount ?? 0) > 0;
  }

  async updateRole(id: number, role: AdminRole): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'UPDATE admins SET role = $1, permissions_updated_at = NOW() WHERE id = $2',
      [role, id]
    );
    return (rowCount ?? 0) > 0;
  }

  async updatePermissions(id: number, permissions: Record<string, boolean>): Promise<boolean> {
    const { rowCount } = await getPool().query(
      'UPDATE admins SET permissions = $1, permissions_updated_at = NOW() WHERE id = $2',
      [JSON.stringify(permissions), id]
    );
    return (rowCount ?? 0) > 0;
  }
}

export const adminService = new AdminService();
