"use strict";
/**
 * Organizer auth service — login, token issue/refresh, password management.
 *
 * Uses a separate JWT secret (organizerSecret) so organizer tokens are
 * cryptographically distinct from admin and user tokens.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.organizerAuthService = exports.OrganizerAuthService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
const errorHandler_1 = require("../middleware/errorHandler");
const organizerUserRepository_1 = require("../repositories/organizerUserRepository");
const organizerAppRepository_1 = require("../repositories/organizerAppRepository");
const logger_1 = require("../utils/logger");
class OrganizerAuthService {
    async login(input) {
        const user = await organizerUserRepository_1.organizerUserRepository.findByEmail(input.email);
        if (!user || !user.is_active) {
            throw new errorHandler_1.AppError('Invalid email or password', 401);
        }
        const passwordValid = await organizerUserRepository_1.organizerUserRepository.verifyPassword(user, input.password);
        if (!passwordValid) {
            throw new errorHandler_1.AppError('Invalid email or password', 401);
        }
        const result = await this.issueTokens(user);
        await organizerUserRepository_1.organizerUserRepository.updateLastLogin(user.id);
        logger_1.logger.info('Organizer login', { userId: user.id, email: user.email });
        return result;
    }
    async issueTokens(user) {
        const payload = {
            id: Number(user.id),
            sub: user.email,
            organization_id: Number(user.organization_id),
            name: user.name,
            role: user.role,
            permissions: user.permissions || {},
            typ: 'organizer_access',
        };
        const accessToken = jsonwebtoken_1.default.sign(payload, config_1.config.jwt.organizerSecret, {
            expiresIn: config_1.config.jwt.organizerExpiresIn,
        });
        const refreshToken = jsonwebtoken_1.default.sign({ sub: user.id, typ: 'organizer_refresh' }, config_1.config.jwt.organizerSecret, { expiresIn: '30d' });
        const { password_hash: _pw, ...safeUser } = user;
        return {
            user: safeUser,
            accessToken,
            refreshToken,
        };
    }
    verifyAccessToken(token) {
        try {
            return jsonwebtoken_1.default.verify(token, config_1.config.jwt.organizerSecret);
        }
        catch {
            return null;
        }
    }
    verifyRefreshToken(token) {
        try {
            return jsonwebtoken_1.default.verify(token, config_1.config.jwt.organizerSecret);
        }
        catch {
            return null;
        }
    }
    async refreshUserTokens(userId) {
        const user = await organizerUserRepository_1.organizerUserRepository.findById(userId);
        if (!user || !user.is_active)
            return null;
        return this.issueTokens(user);
    }
    async validateUserOwnership(userId, organizationId) {
        const user = await organizerUserRepository_1.organizerUserRepository.findById(userId);
        if (!user)
            return false;
        return user.organization_id === organizationId && user.is_active;
    }
    async checkApplicationStatus(organizationId) {
        const app = await organizerAppRepository_1.organizerAppRepository.findByOrganizationId(organizationId);
        return app ? app.status : null;
    }
}
exports.OrganizerAuthService = OrganizerAuthService;
// ── Singleton ──────────────────────────────────────────────────────────────
const organizerAuthService = new OrganizerAuthService();
exports.organizerAuthService = organizerAuthService;
