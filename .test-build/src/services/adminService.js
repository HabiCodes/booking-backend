"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminService = exports.AdminService = void 0;
const crypto_1 = require("../utils/crypto");
const pool_1 = require("../db/pool");
const jwt_1 = require("../utils/jwt");
const errorHandler_1 = require("../middleware/errorHandler");
const permissions_1 = require("../rbac/permissions");
function normalizePermissions(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'boolean')
                out[k] = v;
        }
        return out;
    }
    return {};
}
function rowToRecord(r) {
    return {
        id: Number(r.id),
        email: String(r.email),
        password_hash: String(r.password_hash),
        name: String(r.name),
        role: r.role,
        is_active: Boolean(r.is_active),
        last_login_at: r.last_login_at,
        permissions: normalizePermissions(r.permissions),
    };
}
class AdminService {
    /**
     * Authenticate an admin and issue a JWT carrying role + effective permissions.
     * Updates `last_login_at` opportunistically (failure here doesn't break login).
     */
    async login(email, password) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, password_hash, name, role, is_active, last_login_at, permissions
       FROM admins WHERE email = $1 LIMIT 1`, [email.toLowerCase().trim()]);
        const admin = rowToRecord(rows[0]);
        if (!admin) {
            throw new errorHandler_1.AppError('Invalid credentials', 401);
        }
        if (!admin.is_active) {
            throw new errorHandler_1.AppError('Account is disabled', 403);
        }
        const valid = await (0, crypto_1.comparePassword)(password, admin.password_hash);
        if (!valid) {
            throw new errorHandler_1.AppError('Invalid credentials', 401);
        }
        const effectivePermissions = (0, permissions_1.computePermissions)(admin.role, admin.permissions);
        const token = (0, jwt_1.generateAdminAccessToken)(admin.id, admin.email, admin.role, effectivePermissions);
        // best-effort last_login update
        try {
            await (0, pool_1.getPool)().query('UPDATE admins SET last_login_at = NOW() WHERE id = $1', [admin.id]);
        }
        catch {
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
    async seed(email, password, name, role = 'admin') {
        const passwordHash = await (0, crypto_1.hashPassword)(password);
        const { rows: existingRows } = await (0, pool_1.getPool)().query('SELECT id FROM admins WHERE email = $1 LIMIT 1', [email.toLowerCase().trim()]);
        const found = existingRows[0];
        if (found) {
            await (0, pool_1.getPool)().query('UPDATE admins SET password_hash = $1, name = $2 WHERE id = $3', [passwordHash, name, found.id]);
            return { created: false, adminId: found.id };
        }
        const { rows: inserted } = await (0, pool_1.getPool)().query('INSERT INTO admins (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id', [email.toLowerCase().trim(), passwordHash, name, role]);
        const adminId = (inserted[0]?.id) ?? 0;
        return { created: true, adminId };
    }
    // ── Listing / management (used by the Admin Dashboard) ─────────────────────
    async listAll(limit = 50, offset = 0) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, name, role, is_active, last_login_at, permissions, created_at
       FROM admins
       ORDER BY id ASC
       LIMIT $1 OFFSET $2`, [limit, offset]);
        return rows;
    }
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, name, role, is_active, last_login_at, permissions, created_at
       FROM admins WHERE id = $1 LIMIT 1`, [id]);
        return rows[0] ?? null;
    }
    async setActive(id, isActive) {
        const { rowCount } = await (0, pool_1.getPool)().query('UPDATE admins SET is_active = $1 WHERE id = $2', [isActive, id]);
        return (rowCount ?? 0) > 0;
    }
    async updateRole(id, role) {
        const { rowCount } = await (0, pool_1.getPool)().query('UPDATE admins SET role = $1 WHERE id = $2', [role, id]);
        return (rowCount ?? 0) > 0;
    }
    async updatePermissions(id, permissions) {
        const { rowCount } = await (0, pool_1.getPool)().query('UPDATE admins SET permissions = $1 WHERE id = $2', [JSON.stringify(permissions), id]);
        return (rowCount ?? 0) > 0;
    }
}
exports.AdminService = AdminService;
exports.adminService = new AdminService();
