"use strict";
/**
 * User repository — backward compatible with existing code.
 * Migration 001 adds: username, is_verified, is_active, last_login_at, email_verified_at
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = exports.UserRepository = void 0;
const pool_1 = require("../db/pool");
const crypto_1 = require("../utils/crypto");
class UserRepository {
    async findByEmail(email) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, username, password_hash, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users WHERE email = $1 LIMIT 1`, [email.toLowerCase().trim()]);
        return rows[0] || null;
    }
    async findByUsername(username) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, username, password_hash, is_verified, is_active,
              last_login_at, email_verified_at, created_at
       FROM users WHERE username = $1 LIMIT 1`, [username]);
        return rows[0] || null;
    }
    async findById(id) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, username, is_verified, is_active, created_at
       FROM users WHERE id = $1`, [id]);
        return rows[0] || null;
    }
    /** Legacy: register with just email+password */
    async create(email, password) {
        const passwordHash = await this.hashPassword(password);
        const { rows } = await (0, pool_1.getPool)().query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email.toLowerCase().trim(), passwordHash]);
        const result = rows[0];
        return result?.id ?? 0;
    }
    /** New: register with username as well */
    async createWithUsername(email, username, passwordHash) {
        // Defensive: never store empty string as username — use NULL instead
        const safeUsername = username && username.trim() ? username.trim() : null;
        const { rows } = await (0, pool_1.getPool)().query('INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id', [email.toLowerCase().trim(), safeUsername, passwordHash]);
        const result = rows[0];
        return result?.id ?? 0;
    }
    async verifyPassword(password, hash) {
        return (0, crypto_1.comparePassword)(password, hash);
    }
    async hashPassword(password) {
        const bcrypt = await Promise.resolve().then(() => __importStar(require('bcrypt')));
        return bcrypt.hash(password, 12);
    }
    async updateLastLogin(id) {
        await (0, pool_1.getPool)().query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
    }
    async setVerified(id) {
        await (0, pool_1.getPool)().query('UPDATE users SET is_verified = true, email_verified_at = NOW() WHERE id = $1', [id]);
    }
    async getUserTicketCount(userId, eventId) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT COUNT(*) as total FROM tickets t
       INNER JOIN bookings b ON t.booking_id = b.id
       WHERE b.user_id = $1 AND b.event_id = $2
         AND b.status IN ('confirmed','attended')
         AND t.deleted_at IS NULL AND b.deleted_at IS NULL`, [userId, eventId]);
        const row = rows;
        const total = row[0]?.total ?? 0;
        return typeof total === 'string' ? parseInt(total, 10) : Number(total);
    }
    async list(limit, offset) {
        const { rows } = await (0, pool_1.getPool)().query(`SELECT id, email, username, is_verified, is_active, created_at
       FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        return rows;
    }
}
exports.UserRepository = UserRepository;
exports.userRepository = new UserRepository();
