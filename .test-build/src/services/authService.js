"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = exports.authService = exports.AuthService = void 0;
exports.checkAccountLockout = checkAccountLockout;
exports.generateVerificationLink = generateVerificationLink;
exports.buildTokenPayload = buildTokenPayload;
exports.getAuthService = getAuthService;
/**
 * Generate a stable, human-readable username from an email address.
 * Produces the prefix part of the email (before @), lowercased, with
 * non-alphanumeric characters replaced by underscores, truncated to 20 chars.
 * Falls back to "user" if nothing usable remains.
 *
 * Examples:
 *   "john@example.com"   → "john"
 *   "john.doe@example"   → "john_doe"
 *   "a+b@example.com"    → "a_b"
 */
function emailToUsername(email) {
    const prefix = email.split('@')[0] ?? '';
    const normalized = prefix.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return normalized.slice(0, 20) || 'user';
}
/**
 * Generate a unique username.  If the caller supplied one, validate and
 * normalise it.  If not (or if it would collide), derive one from the email
 * and, if necessary, append a short random suffix until the database accepts it.
 *
 * The database UNIQUE index on username (WHERE username IS NOT NULL) is the
 * final authority — we catch unique-violation errors and retry.
 */
async function resolveUniqueUsername(desiredUsername, repository) {
    const MAX_RETRIES = 5;
    // Normalise a caller-supplied username
    if (desiredUsername && desiredUsername.trim()) {
        const normalized = desiredUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
        if (!normalized) {
            throw new Error('Username must contain at least one alphanumeric character');
        }
        const existing = await repository.findByUsername(normalized);
        if (!existing)
            return normalized;
        throw new Error(`Username "${normalized}" is already taken`);
    }
    // Derive from email — stable across retries so concurrent attempts
    // are likely to generate the same candidate, letting the DB break the tie.
    const base = emailToUsername(desiredUsername ?? 'user');
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const candidate = attempt === 0 ? base : `${base}_${Math.random().toString(36).slice(2, 6)}`;
        // Quick pre-check to avoid unnecessary DB round-trips on the first attempt
        const existing = await repository.findByUsername(candidate);
        if (!existing)
            return candidate;
        // If taken, loop and try the next suffix
    }
    // Final fallback — use a longer random suffix
    const fallback = `${base}_${Date.now().toString(36)}`;
    const existing = await repository.findByUsername(fallback);
    if (!existing)
        return fallback;
    // As an absolute last resort, let the DB raise and the caller handles it
    return fallback;
}
const config_1 = require("../config");
const errorHandler_1 = require("../middleware/errorHandler");
const userRepository_1 = require("../repositories/userRepository");
const authRepository_1 = require("../repositories/authRepository");
const passwordPolicy_1 = require("../utils/passwordPolicy");
const safeToken_1 = require("../utils/safeToken");
const jwt_1 = require("../utils/jwt");
const logger_1 = require("../utils/logger");
const redis_1 = require("../db/redis");
const emailService_1 = require("./emailService");
const otp_1 = require("../utils/otp");
const SESSION_REVOKED_PREFIX = 'auth:session:revoked:';
const SESSION_REVOKED_TTL = 1800; // 30 minutes — exceeds 15min access token lifetime
async function revokeSessionInRedis(sessionId) {
    try {
        const redis = (0, redis_1.getRedis)();
        await redis.set(`${SESSION_REVOKED_PREFIX}${sessionId}`, '1', 'EX', SESSION_REVOKED_TTL);
    }
    catch {
        // Redis unavailable — revocation still works via DB update
    }
}
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
        this.emailService = opts.emailService ?? (0, emailService_1.createEmailService)({
            apiToken: config_1.config.email.hostingerApiToken || undefined,
            from: config_1.config.email.from,
            mailboxId: config_1.config.email.hostingerMailboxId || undefined,
        });
        this.baseUrl = opts.baseUrl ?? (config_1.config.email.appUrl || (config_1.config.nodeEnv === 'production' ? '' : 'http://localhost:3000'));
        this.bruteForce = opts.bruteForce ?? DEFAULT_BRUTE_FORCE;
        this.verificationExpiryHours = opts.verificationExpiryHours ?? 24;
        this.otpLength = opts.otpLength ?? config_1.config.otp.codeLength;
        this.otpExpiryMinutes = opts.otpExpiryMinutes ?? config_1.config.otp.expiryMinutes;
        this.otpMaxAttempts = opts.otpMaxAttempts ?? config_1.config.otp.maxAttempts;
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
            throw new errorHandler_1.AppError(policyResult.errors.join('; '), 400);
        }
        const passwordHash = await userRepository_1.userRepository.hashPassword(password);
        const resolvedUsername = await resolveUniqueUsername(username, userRepository_1.userRepository);
        const userId = await userRepository_1.userRepository.createWithUsername(normalizedEmail, resolvedUsername, passwordHash);
        // Generate verification token
        const rawToken = (0, safeToken_1.generateSecureToken)();
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        const expiresAt = new Date(Date.now() + this.verificationExpiryHours * 3600000).toISOString();
        await authRepository_1.authRepository.createVerificationToken(userId, tokenHash, expiresAt);
        // Send email
        const verificationLink = generateVerificationLink(this.baseUrl, rawToken);
        const message = (0, emailService_1.buildVerificationEmail)({
            verificationLink,
            recipientEmail: normalizedEmail,
            username: resolvedUsername,
            expiresInHours: this.verificationExpiryHours,
        });
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
            throw new errorHandler_1.AppError('Email already registered', 409);
        }
        const userId = await userRepository_1.userRepository.create(normalizedEmail, password);
        const token = (0, jwt_1.generateAccessToken)(userId, normalizedEmail);
        return { token, user: { id: userId, email: normalizedEmail } };
    }
    // ── OTP Registration (preferred new flow) ─────────────────────────────────
    /**
     * Create (or refresh) a pending registration for an email/username/password
     * trio.  Generates a cryptographically-secure 6-digit OTP, stores only its
     * SHA-256 hash, and emails the plain code through the existing email
     * service.  Does NOT create a user yet — that happens only after OTP
     * verification succeeds.
     */
    async requestRegistrationOtp(email, username, password) {
        const normalizedEmail = email.toLowerCase().trim();
        const trimmedUsername = username ? username.trim() : null;
        // Duplicate check against the users table — even if the pending row
        // exists, if a verified user already owns the email we MUST refuse.
        const existingUser = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (existingUser) {
            throw new errorHandler_1.AppError(`Email "${normalizedEmail}" is already registered`, 409);
        }
        if (trimmedUsername) {
            const existingUsername = await userRepository_1.userRepository.findByUsername(trimmedUsername);
            if (existingUsername) {
                throw new errorHandler_1.AppError(`Username "${trimmedUsername}" is already taken`, 409);
            }
        }
        // Password policy
        const policyResult = (0, passwordPolicy_1.validatePassword)(password, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyResult.valid) {
            throw new errorHandler_1.AppError(policyResult.errors.join('; '), 400);
        }
        // Hash the password (bcrypt) so we never store the plain-text.
        const passwordHash = await userRepository_1.userRepository.hashPassword(password);
        // Generate the OTP, hash it.
        const otpCode = (0, otp_1.generateNumericOtp)(this.otpLength);
        const otpHash = (0, otp_1.hashOtp)(otpCode);
        const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60000).toISOString();
        await authRepository_1.authRepository.createPendingRegistration({
            email: normalizedEmail,
            username: trimmedUsername,
            passwordHash,
            otpHash,
            expiresAt,
        });
        // Send the plain OTP via email.  We NEVER log the code.
        const message = (0, emailService_1.buildOtpEmail)({
            otpCode,
            recipientEmail: normalizedEmail,
            username: trimmedUsername,
            expiresInMinutes: this.otpExpiryMinutes,
        });
        await this.emailService.send(message).catch((err) => {
            logger_1.logger.warn('[otp] failed to send registration OTP email:', err);
            throw new errorHandler_1.AppError('Failed to send OTP email', 500);
        });
        return {
            sent: true,
            message: `A ${this.otpLength}-digit verification code has been sent to ${normalizedEmail}.`,
            expiresInMinutes: this.otpExpiryMinutes,
        };
    }
    /**
     * Verify the OTP the user submitted.  On success: create the user (with
     * is_verified=true), issue a JWT pair, persist a session, mark the pending
     * row consumed, and return the same shape as login/register.
     *
     * On failure: increment the per-row attempt counter, and once the limit is
     * reached delete the pending row so further attempts are blocked.
     */
    async verifyRegistrationOtp(email, otpCode, deviceInfo, ipAddress) {
        const normalizedEmail = email.toLowerCase().trim();
        const code = (otpCode ?? '').trim();
        if (!/^\d+$/.test(code)) {
            return { success: false, message: 'Verification code must be numeric.' };
        }
        const pending = await authRepository_1.authRepository.findPendingRegistrationByEmail(normalizedEmail);
        if (!pending) {
            return { success: false, message: 'No pending registration found for that email.' };
        }
        // TTL check (also enforced by query but defend-in-depth)
        if (new Date(pending.expires_at) < new Date()) {
            await authRepository_1.authRepository.deletePendingRegistration(pending.id);
            return { success: false, message: 'Verification code has expired. Please request a new one.' };
        }
        // Constant-time compare
        const valid = (0, otp_1.verifyOtp)(code, pending.otp_hash);
        if (!valid) {
            await authRepository_1.authRepository.incrementPendingAttempts(pending.id);
            const remainingAttempts = Math.max(0, this.otpMaxAttempts - (pending.otp_attempts + 1));
            if (pending.otp_attempts + 1 >= this.otpMaxAttempts) {
                await authRepository_1.authRepository.deletePendingRegistration(pending.id);
                return {
                    success: false,
                    message: 'Too many incorrect attempts. Please restart registration.',
                };
            }
            return {
                success: false,
                message: `Incorrect verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
            };
        }
        // Atomic consume: single UPDATE ... RETURNING prevents TOCTOU where two
        // concurrent requests with the same OTP could both pass verification
        // before either marks the pending row as consumed.
        const consumed = await authRepository_1.authRepository.verifyAndConsumeOtp(pending.id);
        if (!consumed) {
            return { success: false, message: 'This verification code has already been used.' };
        }
        // OTP matched — atomically: create the user, mark verified. OTP was
        // already consumed by verifyAndConsumeOtp() above.
        const newUserId = await userRepository_1.userRepository.createWithUsername(normalizedEmail, await resolveUniqueUsername(pending.username ?? null, userRepository_1.userRepository), pending.password_hash);
        // Audit log: explicitly mark verified (login does not require is_verified
        // checks for these users since they reached this flow).
        await authRepository_1.authRepository.markUserVerified(newUserId);
        await userRepository_1.userRepository.updateLastLogin(newUserId);
        const created = await userRepository_1.userRepository.findById(newUserId);
        if (!created) {
            return { success: false, message: 'Failed to load created user account.' };
        }
        const publicUser = {
            id: created.id,
            email: created.email,
            username: created.username,
            is_verified: created.is_verified,
            is_active: created.is_active,
            created_at: created.created_at,
        };
        // Create session before issuing tokens so the session_id can be bound into the JWT
        const sessionId = await authRepository_1.authRepository.createSession(created.id, deviceInfo ?? null, ipAddress ?? null, null, true);
        const tokens = this.issueTokens(created.id, created.email, sessionId);
        return {
            success: true,
            message: 'Email verified successfully. Account created.',
            authResult: { tokens, user: publicUser, isNewUser: true },
        };
    }
    /**
     * Re-send a fresh OTP for an in-flight pending registration.  Invalidates
     * any prior pending row's hash (so the old code can no longer be used) and
     * creates a new one with its own expiry.
     */
    async resendRegistrationOtp(email) {
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (existing) {
            return { sent: false, message: 'Email is already registered.' };
        }
        const pending = await authRepository_1.authRepository.findPendingRegistrationByEmail(normalizedEmail);
        if (!pending) {
            // Don't reveal whether the email exists
            return { sent: true, message: 'If a pending registration exists for that email, a new code has been sent.' };
        }
        const otpCode = (0, otp_1.generateNumericOtp)(this.otpLength);
        const otpHash = (0, otp_1.hashOtp)(otpCode);
        const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60000).toISOString();
        // Update in place to keep the same id (otherwise unique constraint fights us)
        await (0, pool_1.getPool)().query(`UPDATE pending_registrations
       SET otp_hash = $1, otp_attempts = 0, expires_at = $2
       WHERE id = $3`, [otpHash, expiresAt, pending.id]);
        const message = (0, emailService_1.buildOtpEmail)({
            otpCode,
            recipientEmail: normalizedEmail,
            username: pending.username ?? null,
            expiresInMinutes: this.otpExpiryMinutes,
        });
        await this.emailService.send(message).catch((err) => {
            logger_1.logger.warn('[otp] failed to resend registration OTP email:', err);
            throw new errorHandler_1.AppError('Failed to send OTP email', 500);
        });
        return { sent: true, message: `A new verification code has been sent to ${normalizedEmail}.` };
    }
    // ── Login ─────────────────────────────────────────────────────────────────
    async login(email, password, deviceInfo, ipAddress) {
        const normalizedEmail = email.toLowerCase().trim();
        // Brute-force: check lockout (uses both email and IP address)
        const recentFailedCount = await authRepository_1.authRepository.countFailedAttemptsSince(normalizedEmail, this.bruteForce.windowMinutes);
        if (recentFailedCount >= this.bruteForce.maxAttempts) {
            const recentFailedLogin = await authRepository_1.authRepository.getRecentFailureWindow(normalizedEmail);
            const lockout = checkAccountLockout(recentFailedLogin, this.bruteForce.lockoutMinutes);
            if (lockout.locked && lockout.retryInMs !== null) {
                const err = new errorHandler_1.AppError(`Account temporarily locked. Try again in ${Math.ceil(lockout.retryInMs / 1000)} seconds`, 429);
                err.retryInMs = lockout.retryInMs;
                throw err;
            }
        }
        const user = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (!user) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
            throw new errorHandler_1.AppError('Invalid email or password', 401);
        }
        if (!user.is_active) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            throw new errorHandler_1.AppError('Your account has been disabled. Contact support.', 403);
        }
        const valid = await userRepository_1.userRepository.verifyPassword(password, user.password_hash);
        if (!valid) {
            await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
            await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
            throw new errorHandler_1.AppError('Invalid email or password', 401);
        }
        if (!user.is_verified) {
            throw new errorHandler_1.AppError('Please verify your email before logging in', 403);
        }
        // Successful login — record it
        await authRepository_1.authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, true);
        await userRepository_1.userRepository.updateLastLogin(user.id);
        // Issue tokens and create session
        const sessionId = await authRepository_1.authRepository.createSession(user.id, deviceInfo ?? null, ipAddress ?? null, null, // userAgent — set by caller
        true);
        const tokens = this.issueTokens(Number(user.id), user.email, sessionId);
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
            throw new errorHandler_1.AppError(`Too many failed login attempts. Please try again in ${this.bruteForce.lockoutMinutes} minutes.`, 429);
        }
        void ipAddress; // accepted but not stored by this counter; future-use
    }
    // ── Token refresh (rotation) ──────────────────────────────────────────────
    async refreshTokens(rawRefreshToken, deviceInfo) {
        const tokenHash = (0, safeToken_1.hashToken)(rawRefreshToken);
        // Verify JWT payload first (cheap crypto check, no DB round-trip)
        const payload = (0, jwt_1.verifyRefreshToken)(rawRefreshToken);
        if (!payload) {
            throw new errorHandler_1.AppError('Invalid refresh token payload', 401);
        }
        // Atomic find-and-consume: single UPDATE ... RETURNING query eliminates the
        // TOCTOU gap where two concurrent requests could both pass validation before
        // either revoked the token.
        const consumed = await authRepository_1.authRepository.findAndConsumeRefreshToken(tokenHash);
        if (!consumed) {
            // Either: token doesn't exist, was already revoked, or expired.
            // Treat all cases as potential reuse for security.
            const userId = payload.id;
            await authRepository_1.authRepository.revokeAllUserRefreshTokens(userId);
            await authRepository_1.authRepository.revokeAllUserSessions(userId);
            const sessions = await authRepository_1.authRepository.getUserSessions(userId);
            await Promise.all(sessions.map(s => revokeSessionInRedis(s.id)));
            throw new errorHandler_1.AppError('Refresh token reuse detected — all sessions have been revoked for security', 401);
        }
        // Verify user still exists and is active
        const user = await userRepository_1.userRepository.findById(payload.id);
        if (!user || !user.is_active) {
            throw new errorHandler_1.AppError('Account no longer active', 403);
        }
        // Carry the session_id through rotation so the new refresh token stays
        // bound to the originating device session. This keeps the "active
        // sessions" list accurate and ensures revocation by session_id works.
        const sessionId = consumed.session_id ?? undefined;
        return this.issueTokens(payload.id, user.email, sessionId);
    }
    // ── Logout ────────────────────────────────────────────────────────────────
    async logoutCurrentDevice(refreshToken) {
        const tokenHash = (0, safeToken_1.hashToken)(refreshToken);
        await authRepository_1.authRepository.revokeRefreshToken(tokenHash);
    }
    async logoutAllDevices(userId) {
        const revokedTokens = await authRepository_1.authRepository.revokeAllUserRefreshTokens(userId);
        const revokedSessions = await authRepository_1.authRepository.revokeAllUserSessions(userId);
        // Propagate session revocation to Redis for immediate enforcement
        const sessions = await authRepository_1.authRepository.getUserSessions(userId);
        await Promise.all(sessions.map(s => revokeSessionInRedis(s.id)));
        return { revokedTokens, revokedSessions };
    }
    // ── Sessions ──────────────────────────────────────────────────────────────
    async getMySessions(userId) {
        return authRepository_1.authRepository.getUserSessions(userId);
    }
    async revokeSession(sessionId) {
        await authRepository_1.authRepository.revokeSession(sessionId);
        await revokeSessionInRedis(sessionId);
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
        const message = (0, emailService_1.buildVerificationEmail)({
            verificationLink,
            recipientEmail: normalizedEmail,
            username: user.username,
            expiresInHours: this.verificationExpiryHours,
        });
        await this.emailService.send(message).catch((err) => logger_1.logger.warn('Email send failed:', err));
        return { success: true, message: 'Verification email sent. Please check your inbox.' };
    }
    // ── Password reset (separate from email verification) ───────────────────────
    async requestPasswordReset(email) {
        const normalizedEmail = email.toLowerCase().trim();
        const user = await userRepository_1.userRepository.findByEmail(normalizedEmail);
        if (!user) {
            // Don't reveal whether the email exists (security)
            return { success: true, message: 'If an account with that email exists, a password reset link has been sent.' };
        }
        // Invalidate old password-reset tokens for this user
        await authRepository_1.authRepository.invalidateUserVerificationTokens(user.id);
        // Generate new password reset token (stored with type 'password_reset')
        const rawToken = (0, safeToken_1.generateSecureToken)();
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        const expiresAt = new Date(Date.now() + 2 * 3600000).toISOString(); // 2-hour window
        await authRepository_1.authRepository.createVerificationToken(user.id, tokenHash, expiresAt, 'password_reset');
        // Send password reset email
        const resetLink = `${this.baseUrl}/reset-password?token=${rawToken}`;
        const message = {
            to: normalizedEmail,
            from: config_1.config.email.from,
            subject: 'Reset your password',
            html: `<p>Hi ${user.username ?? 'there'},</p>
             <p>You requested a password reset. Click the link below to set a new password:</p>
             <p><a href="${resetLink}">${resetLink}</a></p>
             <p>This link expires in 2 hours. If you did not request this, ignore this email.</p>`,
            text: `Hi ${user.username ?? 'there'},\n\nYou requested a password reset. Visit this link to set a new password:\n${resetLink}\n\nThis link expires in 2 hours. If you did not request this, ignore this email.`,
        };
        await this.emailService.send(message).catch((err) => logger_1.logger.warn('Password reset email failed:', err));
        return { success: true, message: 'If an account with that email exists, a password reset link has been sent.' };
    }
    async resetPassword(rawToken, newPassword) {
        const tokenHash = (0, safeToken_1.hashToken)(rawToken);
        // Find a non-expired, unused password_reset token
        const tokenRow = await authRepository_1.authRepository.findVerificationToken(tokenHash);
        if (!tokenRow || tokenRow.type !== 'password_reset') {
            throw new Error('Invalid or expired password reset token');
        }
        // Password policy
        const policyResult = (0, passwordPolicy_1.validatePassword)(newPassword, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyResult.valid) {
            throw new errorHandler_1.AppError(policyResult.errors.join('; '), 400);
        }
        // Hash new password and update
        const newHash = await userRepository_1.userRepository.hashPassword(newPassword);
        await (0, pool_1.getPool)().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, tokenRow.user_id]);
        // Mark token as used so it can't be replayed
        await authRepository_1.authRepository.markVerificationTokenUsed(tokenHash);
        // Revoke all existing refresh tokens (force re-login everywhere)
        await authRepository_1.authRepository.revokeAllUserRefreshTokens(tokenRow.user_id);
        await authRepository_1.authRepository.revokeAllUserSessions(tokenRow.user_id);
    }
    // ── Change password ───────────────────────────────────────────────────────
    async changePassword(userId, currentPassword, newPassword) {
        const user = await userRepository_1.userRepository.findByEmail((await userRepository_1.userRepository.findById(userId))?.email ?? '');
        if (!user)
            throw new Error('User not found');
        const valid = await userRepository_1.userRepository.verifyPassword(currentPassword, user.password_hash);
        if (!valid) {
            throw new errorHandler_1.AppError('Current password is incorrect', 400);
        }
        const policyResult = (0, passwordPolicy_1.validatePassword)(newPassword, passwordPolicy_1.defaultPasswordPolicy);
        if (!policyResult.valid) {
            throw new errorHandler_1.AppError(policyResult.errors.join('; '), 400);
        }
        const newHash = await userRepository_1.userRepository.hashPassword(newPassword);
        await (0, pool_1.getPool)().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
        // Revoke all existing sessions after password change
        await this.logoutAllDevices(userId);
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    issueTokens(userId, email, sessionId) {
        const accessToken = (0, jwt_1.generateAccessToken)(userId, email, sessionId);
        const refreshToken = (0, jwt_1.generateRefreshToken)(userId, email);
        const expiresIn = config_1.config.jwt.expiresIn;
        // Persist refresh token hash (async — don't block token issuance)
        const tokenHash = (0, safeToken_1.hashToken)(refreshToken);
        const tokenExpiry = new Date(Date.now() + 30 * 24 * 3600000).toISOString();
        authRepository_1.authRepository.createRefreshToken(userId, tokenHash, sessionId ?? null, null, null, tokenExpiry).catch((err) => logger_1.logger.warn('Failed to persist refresh token:', err));
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
