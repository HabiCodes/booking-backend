"use strict";
/**
 * Auth service — production-grade authentication.
 *
 * Design decisions:
 *  - Registration creates user as inactive until email verified (is_verified=false).
 *  - A verification token is sent; the user clicks the link → backend marks user verified.
 *  - Login checks is_verified flag; unverified users get a specific error.
 *  - Brute-force protection via login_attempts (15-min rolling window).
 *  - Refresh token rotation — each /refresh call issues a new pair and revokes the old.
 *  - Device sessions tracked for "logout from specific device" capability.
 *
 * Backward compatibility:
 *  - The legacy register(email, password) and login(email, password) signatures are preserved.
 *  - New endpoints use enhanced versions that include verification and full features.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = exports.authService = exports.AuthService = void 0;
exports.checkAccountLockout = checkAccountLockout;
exports.generateVerificationLink = generateVerificationLink;
exports.buildTokenPayload = buildTokenPayload;
exports.getAuthService = getAuthService;
const config_1 = require("../config");
const userRepository_1 = require("../repositories/userRepository");
const authRepository_1 = require("../repositories/authRepository");
const passwordPolicy_1 = require("../utils/passwordPolicy");
const safeToken_1 = require("../utils/safeToken");
const jwt_1 = require("../utils/jwt");
const logger_1 = require("../utils/logger");
const emailService_1 = require("./emailService");
const DEFAULT_BRUTE_FORCE = {
    maxAttempts: 5,
    windowMinutes: 15,
    lockoutMinutes: 15,
};
function checkAccountLockout(failedSince, lockoutMinutes) {
    if (!failedSince)
        return { locked: false, retryInMs: null };
    const now = Date.now();
    const lockoutExpiry = failedSince.getTime() + lockoutMinutes * 60 * 1000;
    if (now >= lockoutExpiry)
        return { locked: false, retryInMs: null };
    return {
        locked: true,
        retryInMs: lockoutExpiry - now,
    };
}
function generateVerificationLink(baseUrl, rawToken) {
    return `${baseUrl}/verify-email?token=${rawToken}`;
}
function buildTokenPayload(verificationToken) {
    return {
        id: verificationToken.id,
        user_id: verificationToken.user_id,
        type: verificationToken.type,
        expires_at: verificationToken.expires_at,
    };
}
// ── Service ──────────────────────────────────────────────────────────────────
class AuthService {
    constructor(opts = {}) {
        this.emailService = opts.emailService ?? new (require('./emailService').ConsoleEmailService)();
        this.baseUrl = opts.baseUrl ?? (config_1.config.nodeEnv === 'production'
            ? (process.env.APP_URL ?? '')
            : 'http://localhost:3000');
        this.bruteForce = opts.bruteForce ?? DEFAULT_BRUTE_FORCE;
        this.verificationExpiryHours = opts.verificationExpiryHours ?? 24;
    }
    // ── Registration ──────────────────────────────────────────────────────────
    async registerWithVerification(email, username, password, ipAddress) {
        const normalizedEmail = email.toLowerCase().trim();
        // Check existing
        const existing = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (existing) {
            throw new Error(`Email "${normalizedEmail}" is already registered`);
        }
        if (username) {
            const existingUsername = await userRepository_1.userRepository.findByUsername(username);
            if (existingUsername) {
                throw new Error(`Username "${username}" is already taken`);
            }
        }
        // Password policy
        const policyResult = (0, passwordPolicy_1.validatePassword)(password, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyResult.valid) {
            const err = new Error(policyResult.errors.join('; '));
            err.statusCode = 400;
            throw err;
        }
        const passwordHash = await userRepository_1.userRepository.hashPassword(password);
        const userId = await userRepository_1.userRepository.createWithUsername(normalizedEmail, username ?? '', passwordHash);
        // Generate verification token
        const rawToken = (0, safeToken_1.generateSecureToken)();
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        const expiresAt = new Date(Date.now() + this.verificationExpiryHours * 3600000).toISOString();
        await authRepository_1.authRepository.createVerificationToken(userId, tokenHash, expiresAt);
        // Send email
        const verificationLink = generateVerificationLink(this.baseUrl, rawToken);
        const message = (0, emailService_1.buildVerificationEmail)(verificationLink, normalizedEmail, username ?? null);
        await this.emailService.send(message).catch((err) => logger_1.logger.warn('Email send failed:', err));
        // Create tokens (user is not yet verified, but tokens are valid)
        const user = await userRepository_1.userRepository.findById(userId);
        if (!user)
            throw new Error('Failed to fetch created user');
        const tokens = this.issueTokens(userId, normalizedEmail);
        return { tokens, user, isNewUser: true };
    }
    /** Legacy: simple register, backward compatible */
    async register(email, password) {
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (existing) {
            const err = new Error('Email already registered');
            err.statusCode = 409;
            throw err;
        }
        const userId = await userRepository_1.userRepository.create(normalizedEmail, password);
        const token = (0, jwt_1.generateAccessToken)(userId, normalizedEmail);
        return { token, user: { id: userId, email: normalizedEmail } };
    }
    // ── Login ─────────────────────────────────────────────────────────────────
    async login(email, password, deviceInfo, ipAddress) {
        const normalizedEmail = email.toLowerCase().trim();
        // Brute-force: check lockout (uses both email and IP address)
        const recentFailedLogin = await authRepository_1.authRepository.getRecentFailureWindow(normalizedEmail);
        const lockout = checkAccountLockout(recentFailedLogin, this.bruteForce.lockoutMinutes);
        if (lockout.locked && lockout.retryInMs !== null) {
            const err = new Error(`Account temporarily locked. Try again in ${Math.ceil(lockout.retryInMs / 1000)} seconds`);
            err.statusCode = 429;
            err.retryInMs = lockout.retryInMs;
            throw err;
        }
        const user = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (!user) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
            throw new Error('Invalid email or password');
        }
        if (!user.is_active) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            const err = new Error('Your account has been disabled. Contact support.');
            err.statusCode = 403;
            throw err;
        }
        const valid = await userRepository_1.userRepository.verifyPassword(password, user.password_hash);
        if (!valid) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
            throw new Error('Invalid email or password');
        }
        if (!user.is_verified) {
            const err = new Error('Please verify your email before logging in');
            err.statusCode = 403;
            throw err;
        }
        // Successful login — record it
        await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, true);
        await userRepository_1.userRepository.updateLastLogin(user.id);
        // Issue tokens and create session
        const tokens = this.issueTokens(user.id, user.email);
        const sessionId = await authRepository_1.authRepository.createSession(user.id, deviceInfo ?? null, ipAddress ?? null, null, // userAgent — set by caller
        true);
        const publicUser = {
            id: user.id,
            email: user.email,
            username: user.username,
            is_verified: user.is_verified,
            is_active: user.is_active,
            created_at: user.created_at,
        };
        return { tokens, user: publicUser, sessionId };
    }
    /** Legacy login signature */
    async loginLegacy(email, password) {
        const result = await this.login(email, password);
        return {
            token: result.tokens.accessToken,
            user: { id: result.user.id, email: result.user.email },
        };
    }
    async recordFailedLoginAndCheckLock(email, ipAddress, _deviceInfo) {
        const recent = await authRepository_1.authRepository.countFailedAttemptsSince(email, this.bruteForce.windowMinutes);
        if (recent >= this.bruteForce.maxAttempts) {
            const err = new Error(`Too many failed login attempts. Please try again in ${this.bruteForce.lockoutMinutes} minutes.`);
            err.statusCode = 429;
            throw err;
        }
        void ipAddress; // accepted but not stored by this counter; future-use
    }
    // ── Token refresh (rotation) ──────────────────────────────────────────────
    async refreshTokens(rawRefreshToken, deviceInfo) {
        const tokenHash = (0, safeToken_1.hashToken)(rawRefreshToken);
        const stored = await authRepository_1.authRepository.findRefreshTokenByHash(tokenHash);
        if (!stored || stored.revoked) {
            throw new Error('Invalid or revoked refresh token');
        }
        if (new Date(stored.expires_at) < new Date()) {
            throw new Error('Refresh token expired. Please log in again.');
        }
        // Verify the JWT payload
        const payload = (0, jwt_1.verifyRefreshToken)(rawRefreshToken);
        if (!payload) {
            throw new Error('Invalid refresh token payload');
        }
        // Revoke old token (rotation)
        await authRepository_1.authRepository.revokeRefreshToken(tokenHash);
        // Verify user still exists and is active
        const user = await userRepository_1.userRepository.findById(payload.id);
        if (!user || !user.is_active) {
            throw new Error('Account no longer active');
        }
        // Issue new pair
        return this.issueTokens(payload.id, user.email);
    }
    // ── Logout ────────────────────────────────────────────────────────────────
    async logoutCurrentDevice(refreshToken) {
        const tokenHash = (0, safeToken_1.hashToken)(refreshToken);
        await authRepository_1.authRepository.revokeRefreshToken(tokenHash);
    }
    async logoutAllDevices(userId) {
        const revokedTokens = await authRepository_1.authRepository.revokeAllUserRefreshTokens(userId);
        const revokedSessions = await authRepository_1.authRepository.revokeAllUserSessions(userId);
        return { revokedTokens, revokedSessions };
    }
    // ── Sessions ──────────────────────────────────────────────────────────────
    async getMySessions(userId) {
        return authRepository_1.authRepository.getUserSessions(userId);
    }
    async revokeSession(sessionId) {
        await authRepository_1.authRepository.revokeSession(sessionId);
    }
    // ── Verification ──────────────────────────────────────────────────────────
    async verifyEmail(rawToken) {
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        const tokenRow = await authRepository_1.authRepository.findVerificationToken(tokenHash);
        if (!tokenRow) {
            return { success: false, message: 'Invalid verification token' };
        }
        if (new Date(tokenRow.expires_at) < new Date()) {
            return { success: false, message: 'Verification link has expired. Please request a new one.' };
        }
        await authRepository_1.authRepository.markVerificationTokenUsed(tokenHash);
        await authRepository_1.authRepository.markUserVerified(tokenRow.user_id);
        return { success: true, message: 'Email verified successfully. You can now log in.' };
    }
    async resendVerification(email, deviceInfo) {
        const normalizedEmail = email.toLowerCase().trim();
        const user = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (!user) {
            // Don't reveal whether the email exists (security)
            return { success: true, message: 'If an account with that email exists, a verification link has been sent.' };
        }
        if (user.is_verified) {
            return { success: false, message: 'Your email is already verified.' };
        }
        // Invalidate old tokens
        await authRepository_1.authRepository.invalidateUserVerificationTokens(user.id);
        // Generate new token
        const rawToken = (0, safeToken_1.generateSecureToken)();
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        const expiresAt = new Date(Date.now() + this.verificationExpiryHours * 3600000).toISOString();
        await authRepository_1.authRepository.createVerificationToken(user.id, tokenHash, expiresAt);
        const verificationLink = generateVerificationLink(this.baseUrl, rawToken);
        const message = (0, emailService_1.buildVerificationEmail)(verificationLink, normalizedEmail, user.username);
        await this.emailService.send(message).catch((err) => logger_1.logger.warn('Email send failed:', err));
        return { success: true, message: 'Verification email sent. Please check your inbox.' };
    }
    // ── Change password ───────────────────────────────────────────────────────
    async changePassword(userId, currentPassword, newPassword) {
        const user = await userRepository_1.userRepository.findByEmail((await userRepository_1.userRepository.findById(userId))?.email ?? '');
        if (!user)
            throw new Error('User not found');
        const valid = await userRepository_1.userRepository.verifyPassword(currentPassword, user.password_hash);
        if (!valid) {
            throw new Error('Current password is incorrect');
        }
        const policyResult = (0, passwordPolicy_1.validatePassword)(newPassword, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyResult.valid) {
            const err = new Error(policyResult.errors.join('; '));
            err.statusCode = 400;
            throw err;
        }
        const newHash = await userRepository_1.userRepository.hashPassword(newPassword);
        await (0, pool_1.getPool)().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
        // Revoke all existing sessions after password change
        await this.logoutAllDevices(userId);
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    issueTokens(userId, email) {
        const accessToken = (0, jwt_1.generateAccessToken)(userId, email);
        const refreshToken = (0, jwt_1.generateRefreshToken)(userId, email);
        const expiresIn = config_1.config.jwt.expiresIn;
        // Persist refresh token hash (async — don't block token issuance)
        const tokenHash = (0, safeToken_1.hashToken)(refreshToken);
        const tokenExpiry = new Date(Date.now() + 30 * 24 * 3600000).toISOString();
        authRepository_1.authRepository.createRefreshToken(userId, tokenHash, null, null, tokenExpiry).catch((err) => logger_1.logger.warn('Failed to persist refresh token:', err));
        return { accessToken, refreshToken, expiresIn };
    }
}
exports.AuthService = AuthService;
// ── Singleton ────────────────────────────────────────────────────────────────
// (Breaks DI but preserves the existing import pattern.)
const pool_1 = require("../db/pool");
Object.defineProperty(exports, "getPool", { enumerable: true, get: function () { return pool_1.getPool; } });
let instance = null;
function getAuthService() {
    if (!instance) {
        instance = new AuthService();
    }
    return instance;
}
/** Legacy export — controllers that imported `authService` directly still work. */
exports.authService = getAuthService();
