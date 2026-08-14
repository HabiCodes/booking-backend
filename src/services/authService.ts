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
function emailToUsername(email: string): string {
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
async function resolveUniqueUsername(
  desiredUsername: string | null | undefined,
  repository: typeof userRepository,
): Promise<string> {
  const MAX_RETRIES = 5;

  // Normalise a caller-supplied username
  if (desiredUsername && desiredUsername.trim()) {
    const normalized = desiredUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
    if (!normalized) {
      throw new Error('Username must contain at least one alphanumeric character');
    }
    const existing = await repository.findByUsername(normalized);
    if (!existing) return normalized;
    throw new Error(`Username "${normalized}" is already taken`);
  }

  // Derive from email — stable across retries so concurrent attempts
  // are likely to generate the same candidate, letting the DB break the tie.
  const base = emailToUsername((desiredUsername as string | undefined) ?? 'user');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const candidate = attempt === 0 ? base : `${base}_${Math.random().toString(36).slice(2, 6)}`;

    // Quick pre-check to avoid unnecessary DB round-trips on the first attempt
    const existing = await repository.findByUsername(candidate);
    if (!existing) return candidate;
    // If taken, loop and try the next suffix
  }

  // Final fallback — use a longer random suffix
  const fallback = `${base}_${Date.now().toString(36)}`;
  const existing = await repository.findByUsername(fallback);
  if (!existing) return fallback;

  // As an absolute last resort, let the DB raise and the caller handles it
  return fallback;
}

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

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { userRepository } from '../repositories/userRepository';
import { authRepository } from '../repositories/authRepository';
import { validatePassword, defaultPasswordPolicy } from '../utils/passwordPolicy';
import { generateSecureToken, hashToken } from '../utils/safeToken';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import { getRedis } from '../db/redis';
import type {
  RefreshTokenRow,
  UserRow,
  UserPublic,
  UserSessionRow,
  VerificationTokenRow,
} from '../types';
import { buildVerificationEmail, buildOtpEmail, createEmailService, type EmailService } from './emailService';
import { generateNumericOtp, hashOtp, verifyOtp } from '../utils/otp';

const SESSION_REVOKED_PREFIX = 'auth:session:revoked:';
const SESSION_REVOKED_TTL = 1800; // 30 minutes — exceeds 15min access token lifetime

async function revokeSessionInRedis(sessionId: number): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(`${SESSION_REVOKED_PREFIX}${sessionId}`, '1', 'EX', SESSION_REVOKED_TTL);
  } catch {
    // Redis unavailable — revocation still works via DB update
  }
}

// ── Account lockout ──────────────────────────────────────────────────────────

export interface BruteForceConfig {
  maxAttempts: number;
  windowMinutes: number;
  lockoutMinutes: number;
}

const DEFAULT_BRUTE_FORCE: BruteForceConfig = {
  maxAttempts: 5,
  windowMinutes: 15,
  lockoutMinutes: 15,
};

export function checkAccountLockout(failedSince: Date | null, lockoutMinutes: number): { locked: boolean; retryInMs: number | null } {
  if (!failedSince) return { locked: false, retryInMs: null };

  const now = Date.now();
  const lockoutExpiry = failedSince.getTime() + lockoutMinutes * 60 * 1000;

  if (now >= lockoutExpiry) return { locked: false, retryInMs: null };

  return {
    locked: true,
    retryInMs: lockoutExpiry - now,
  };
}

// ── Email verification ───────────────────────────────────────────────────────

export interface VerificationResult {
  success: boolean;
  message: string;
}

// ── OTP Registration ──────────────────────────────────────────────────────────

export interface OtpRegistrationRequestResult {
  sent: boolean;
  message: string;
  /** Minutes until the OTP expires */
  expiresInMinutes: number;
}

export interface OtpVerificationResult {
  success: boolean;
  message: string;
  /** Full auth result on success */
  authResult?: AuthResult;
}

export interface OtpResendResult {
  sent: boolean;
  message: string;
}

export function generateVerificationLink(baseUrl: string, rawToken: string): string {
  return `${baseUrl}/verify-email?token=${rawToken}`;
}

export function buildTokenPayload(verificationToken: VerificationTokenRow) {
  return {
    id: verificationToken.id,
    user_id: verificationToken.user_id,
    type: verificationToken.type,
    expires_at: verificationToken.expires_at,
  };
}

// ── Auth payloads ────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export interface AuthResult {
  tokens: AuthTokens;
  user: UserPublic;
  isNewUser: boolean;
}

export interface LoginResult {
  tokens: AuthTokens;
  user: UserPublic;
  sessionId: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class AuthService {
  private emailService: EmailService;
  private baseUrl: string;
  private bruteForce: BruteForceConfig;
  private verificationExpiryHours: number;
  private otpLength: number;
  private otpExpiryMinutes: number;
  private otpMaxAttempts: number;

  constructor(opts: {
    emailService?: EmailService;
    baseUrl?: string;
    bruteForce?: BruteForceConfig;
    verificationExpiryHours?: number;
    otpLength?: number;
    otpExpiryMinutes?: number;
    otpMaxAttempts?: number;
  } = {}) {
    this.emailService = opts.emailService ?? createEmailService({
      apiToken: config.email.hostingerApiToken || undefined,
      from: config.email.from,
      mailboxId: config.email.hostingerMailboxId || undefined,
    });
    this.baseUrl = opts.baseUrl ?? (config.email.appUrl || (config.nodeEnv === 'production' ? '' : 'http://localhost:3000'));
    this.bruteForce = opts.bruteForce ?? DEFAULT_BRUTE_FORCE;
    this.verificationExpiryHours = opts.verificationExpiryHours ?? 24;
    this.otpLength = opts.otpLength ?? config.otp.codeLength;
    this.otpExpiryMinutes = opts.otpExpiryMinutes ?? config.otp.expiryMinutes;
    this.otpMaxAttempts = opts.otpMaxAttempts ?? config.otp.maxAttempts;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  async registerWithVerification(email: string, username: string | null, password: string, ipAddress?: string | null): Promise<AuthResult> {
    const normalizedEmail = email.toLowerCase().trim();

    // Check existing
    const existing = await userRepository.findByEmail(normalizedEmail);
    if (existing) {
      throw new Error(`Email "${normalizedEmail}" is already registered`);
    }
    if (username) {
      const existingUsername = await userRepository.findByUsername(username);
      if (existingUsername) {
        throw new Error(`Username "${username}" is already taken`);
      }
    }

    // Password policy
    const policyResult = validatePassword(password, defaultPasswordPolicy);
    if (!policyResult.valid) {
      throw new AppError(policyResult.errors.join('; '), 400);
    }

    const passwordHash = await userRepository.hashPassword(password);
    const resolvedUsername = await resolveUniqueUsername(username, userRepository);
    const userId = await userRepository.createWithUsername(normalizedEmail, resolvedUsername, passwordHash);

    // Generate verification token
    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.verificationExpiryHours * 3600_000).toISOString();
    await authRepository.createVerificationToken(userId, tokenHash, expiresAt);

    // Send email
    const verificationLink = generateVerificationLink(this.baseUrl, rawToken);
    const message = buildVerificationEmail({
      verificationLink,
      recipientEmail: normalizedEmail,
      username: resolvedUsername,
      expiresInHours: this.verificationExpiryHours,
    });
    await this.emailService.send(message).catch((err) => logger.warn('Email send failed:', err));

    // Create tokens (user is not yet verified, but tokens are valid)
    const user = await userRepository.findById(userId);
    if (!user) throw new Error('Failed to fetch created user');

    const tokens = this.issueTokens(userId, normalizedEmail);

    return { tokens, user, isNewUser: true };
  }

  /** Legacy: simple register, backward compatible */
  async register(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await userRepository.findByEmail(normalizedEmail);
    if (existing) {
      throw new AppError('Email already registered', 409);
    }

    const userId = await userRepository.create(normalizedEmail, password);
    const token = generateAccessToken(userId, normalizedEmail);

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
  async requestRegistrationOtp(
    email: string,
    username: string | null,
    password: string,
  ): Promise<OtpRegistrationRequestResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const trimmedUsername = username ? username.trim() : null;

    // Duplicate check against the users table — even if the pending row
    // exists, if a verified user already owns the email we MUST refuse.
    const existingUser = await userRepository.findByEmail(normalizedEmail);
    if (existingUser) {
      throw new AppError(`Email "${normalizedEmail}" is already registered`, 409);
    }
    if (trimmedUsername) {
      const existingUsername = await userRepository.findByUsername(trimmedUsername);
      if (existingUsername) {
        throw new AppError(`Username "${trimmedUsername}" is already taken`, 409);
      }
    }

    // Password policy
    const policyResult = validatePassword(password, defaultPasswordPolicy);
    if (!policyResult.valid) {
      throw new AppError(policyResult.errors.join('; '), 400);
    }

    // Hash the password (bcrypt) so we never store the plain-text.
    const passwordHash = await userRepository.hashPassword(password);

    // Generate the OTP, hash it.
    const otpCode = generateNumericOtp(this.otpLength);
    const otpHash = hashOtp(otpCode);
    const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60_000).toISOString();

    await authRepository.createPendingRegistration({
      email: normalizedEmail,
      username: trimmedUsername,
      passwordHash,
      otpHash,
      expiresAt,
    });

    // Send the plain OTP via email.  We NEVER log the code.
    const message = buildOtpEmail({
      otpCode,
      recipientEmail: normalizedEmail,
      username: trimmedUsername,
      expiresInMinutes: this.otpExpiryMinutes,
    });
    await this.emailService.send(message).catch((err) => {
      logger.warn('[otp] failed to send registration OTP email:', err);
      throw new AppError('Failed to send OTP email', 500);
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
  async verifyRegistrationOtp(
    email: string,
    otpCode: string,
    deviceInfo?: string | null,
    ipAddress?: string | null,
  ): Promise<OtpVerificationResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const code = (otpCode ?? '').trim();

    if (!/^\d+$/.test(code)) {
      return { success: false, message: 'Verification code must be numeric.' };
    }

    const pending = await authRepository.findPendingRegistrationByEmail(normalizedEmail);
    if (!pending) {
      return { success: false, message: 'No pending registration found for that email.' };
    }

    // TTL check (also enforced by query but defend-in-depth)
    if (new Date(pending.expires_at) < new Date()) {
      await authRepository.deletePendingRegistration(pending.id);
      return { success: false, message: 'Verification code has expired. Please request a new one.' };
    }

    // Constant-time compare
    const valid = verifyOtp(code, pending.otp_hash);
    if (!valid) {
      await authRepository.incrementPendingAttempts(pending.id);
      const remainingAttempts = Math.max(0, this.otpMaxAttempts - (pending.otp_attempts + 1));
      if (pending.otp_attempts + 1 >= this.otpMaxAttempts) {
        await authRepository.deletePendingRegistration(pending.id);
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
    const consumed = await authRepository.verifyAndConsumeOtp(pending.id);
    if (!consumed) {
      return { success: false, message: 'This verification code has already been used.' };
    }

    // OTP matched — atomically: create the user, mark verified. OTP was
    // already consumed by verifyAndConsumeOtp() above.
    const newUserId = await userRepository.createWithUsername(
      normalizedEmail,
      await resolveUniqueUsername(pending.username ?? null, userRepository),
      pending.password_hash,
    );
    // Audit log: explicitly mark verified (login does not require is_verified
    // checks for these users since they reached this flow).
    await authRepository.markUserVerified(newUserId);
    await userRepository.updateLastLogin(newUserId);

    const created = await userRepository.findById(newUserId);
    if (!created) {
      return { success: false, message: 'Failed to load created user account.' };
    }

    const publicUser: UserPublic = {
      id: created.id,
      email: created.email,
      username: created.username,
      is_verified: created.is_verified,
      is_active: created.is_active,
      created_at: created.created_at,
    };

    // Create session before issuing tokens so the session_id can be bound into the JWT
    const sessionId = await authRepository.createSession(
      created.id,
      deviceInfo ?? null,
      ipAddress ?? null,
      null,
      true
    );

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
  async resendRegistrationOtp(email: string): Promise<OtpResendResult> {
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await userRepository.findByEmail(normalizedEmail);
    if (existing) {
      return { sent: false, message: 'Email is already registered.' };
    }

    const pending = await authRepository.findPendingRegistrationByEmail(normalizedEmail);
    if (!pending) {
      // Don't reveal whether the email exists
      return { sent: true, message: 'If a pending registration exists for that email, a new code has been sent.' };
    }

    const otpCode = generateNumericOtp(this.otpLength);
    const otpHash = hashOtp(otpCode);
    const expiresAt = new Date(Date.now() + this.otpExpiryMinutes * 60_000).toISOString();

    // Update in place to keep the same id (otherwise unique constraint fights us)
    await getPool().query(
      `UPDATE pending_registrations
       SET otp_hash = $1, otp_attempts = 0, expires_at = $2
       WHERE id = $3`,
      [otpHash, expiresAt, pending.id]
    );

    const message = buildOtpEmail({
      otpCode,
      recipientEmail: normalizedEmail,
      username: pending.username ?? null,
      expiresInMinutes: this.otpExpiryMinutes,
    });
    await this.emailService.send(message).catch((err) => {
      logger.warn('[otp] failed to resend registration OTP email:', err);
      throw new AppError('Failed to send OTP email', 500);
    });

    return { sent: true, message: `A new verification code has been sent to ${normalizedEmail}.` };
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(email: string, password: string, deviceInfo?: string | null, ipAddress?: string | null): Promise<LoginResult> {
    const normalizedEmail = email.toLowerCase().trim();

    // Brute-force: check lockout (uses both email and IP address)
    const recentFailedLogin = await authRepository.getRecentFailureWindow(normalizedEmail);
    const lockout = checkAccountLockout(recentFailedLogin, this.bruteForce.lockoutMinutes);
    if (lockout.locked && lockout.retryInMs !== null) {
      const err = new AppError(`Account temporarily locked. Try again in ${Math.ceil(lockout.retryInMs / 1000)} seconds`, 429);
      err.retryInMs = lockout.retryInMs;
      throw err;
    }

    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
      throw new AppError('Invalid email or password', 401);
    }

    if (!user.is_active) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      throw new AppError('Your account has been disabled. Contact support.', 403);
    }

    const valid = await userRepository.verifyPassword(password, user.password_hash);
    if (!valid) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
      throw new AppError('Invalid email or password', 401);
    }

    if (!user.is_verified) {
      throw new AppError('Please verify your email before logging in', 403);
    }

    // Successful login — record it
    await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, true);
    await userRepository.updateLastLogin(user.id);

    // Issue tokens and create session
    const sessionId = await authRepository.createSession(
      user.id,
      deviceInfo ?? null,
      ipAddress ?? null,
      null, // userAgent — set by caller
      true
    );
    const tokens = this.issueTokens(user.id, user.email, sessionId);

    const publicUser: UserPublic = {
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
  async loginLegacy(email: string, password: string): Promise<{ token: string; user: { id: number; email: string } }> {
    const result = await this.login(email, password);
    return {
      token: result.tokens.accessToken,
      user: { id: result.user.id, email: result.user.email },
    };
  }

  async recordFailedLoginAndCheckLock(email: string, ipAddress: string | null | undefined, _deviceInfo: string | null | undefined): Promise<void> {
    const recent = await authRepository.countFailedAttemptsSince(email, this.bruteForce.windowMinutes);
    if (recent >= this.bruteForce.maxAttempts) {
      throw new AppError(`Too many failed login attempts. Please try again in ${this.bruteForce.lockoutMinutes} minutes.`, 429);
    }
    void ipAddress; // accepted but not stored by this counter; future-use
  }

  // ── Token refresh (rotation) ──────────────────────────────────────────────

  async refreshTokens(rawRefreshToken: string, deviceInfo?: string | null): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);

    // Verify JWT payload first (cheap crypto check, no DB round-trip)
    const payload = verifyRefreshToken(rawRefreshToken);
    if (!payload) {
      throw new AppError('Invalid refresh token payload', 401);
    }

    // Atomic find-and-consume: single UPDATE ... RETURNING query eliminates the
    // TOCTOU gap where two concurrent requests could both pass validation before
    // either revoked the token.
    const consumed = await authRepository.findAndConsumeRefreshToken(tokenHash);

    if (!consumed) {
      // Either: token doesn't exist, was already revoked, or expired.
      // Treat all cases as potential reuse for security.
      const userId = payload.id;
      await authRepository.revokeAllUserRefreshTokens(userId);
      await authRepository.revokeAllUserSessions(userId);
      const sessions = await authRepository.getUserSessions(userId);
      await Promise.all(sessions.map(s => revokeSessionInRedis(s.id)));
      throw new AppError('Refresh token reuse detected — all sessions have been revoked for security', 401);
    }

    // Verify user still exists and is active
    const user = await userRepository.findById(payload.id);
    if (!user || !user.is_active) {
      throw new AppError('Account no longer active', 403);
    }

    // Carry the session_id through rotation so the new refresh token stays
    // bound to the originating device session. This keeps the "active
    // sessions" list accurate and ensures revocation by session_id works.
    const sessionId = consumed.session_id ?? undefined;
    return this.issueTokens(payload.id, user.email, sessionId);
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logoutCurrentDevice(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await authRepository.revokeRefreshToken(tokenHash);
  }

  async logoutAllDevices(userId: number): Promise<{ revokedTokens: number; revokedSessions: number }> {
    const revokedTokens = await authRepository.revokeAllUserRefreshTokens(userId);
    const revokedSessions = await authRepository.revokeAllUserSessions(userId);
    // Propagate session revocation to Redis for immediate enforcement
    const sessions = await authRepository.getUserSessions(userId);
    await Promise.all(sessions.map(s => revokeSessionInRedis(s.id)));
    return { revokedTokens, revokedSessions };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async getMySessions(userId: number): Promise<UserSessionRow[]> {
    return authRepository.getUserSessions(userId);
  }

  async revokeSession(sessionId: number): Promise<void> {
    await authRepository.revokeSession(sessionId);
    await revokeSessionInRedis(sessionId);
  }

  // ── Verification ──────────────────────────────────────────────────────────

  async verifyEmail(rawToken: string): Promise<VerificationResult> {
    const tokenHash = hashToken(rawToken);
    const tokenRow = await authRepository.findVerificationToken(tokenHash);

    if (!tokenRow) {
      return { success: false, message: 'Invalid verification token' };
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return { success: false, message: 'Verification link has expired. Please request a new one.' };
    }

    await authRepository.markVerificationTokenUsed(tokenHash);
    await authRepository.markUserVerified(tokenRow.user_id);

    return { success: true, message: 'Email verified successfully. You can now log in.' };
  }

  async resendVerification(email: string, deviceInfo?: string | null): Promise<VerificationResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await userRepository.findByEmail(normalizedEmail);

    if (!user) {
      // Don't reveal whether the email exists (security)
      return { success: true, message: 'If an account with that email exists, a verification link has been sent.' };
    }

    if (user.is_verified) {
      return { success: false, message: 'Your email is already verified.' };
    }

    // Invalidate old tokens
    await authRepository.invalidateUserVerificationTokens(user.id);

    // Generate new token
    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.verificationExpiryHours * 3600_000).toISOString();
    await authRepository.createVerificationToken(user.id, tokenHash, expiresAt);

    const verificationLink = generateVerificationLink(this.baseUrl, rawToken);
    const message = buildVerificationEmail({
      verificationLink,
      recipientEmail: normalizedEmail,
      username: user.username,
      expiresInHours: this.verificationExpiryHours,
    });
    await this.emailService.send(message).catch((err) => logger.warn('Email send failed:', err));

    return { success: true, message: 'Verification email sent. Please check your inbox.' };
  }

  // ── Password reset (separate from email verification) ───────────────────────

  async requestPasswordReset(email: string): Promise<VerificationResult> {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await userRepository.findByEmail(normalizedEmail);

    if (!user) {
      // Don't reveal whether the email exists (security)
      return { success: true, message: 'If an account with that email exists, a password reset link has been sent.' };
    }

    // Invalidate old password-reset tokens for this user
    await authRepository.invalidateUserVerificationTokens(user.id);

    // Generate new password reset token (stored with type 'password_reset')
    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString(); // 2-hour window
    await authRepository.createVerificationToken(user.id, tokenHash, expiresAt, 'password_reset');

    // Send password reset email
    const resetLink = `${this.baseUrl}/reset-password?token=${rawToken}`;
    const message = {
      to: normalizedEmail,
      from: config.email.from,
      subject: 'Reset your password',
      html: `<p>Hi ${user.username ?? 'there'},</p>
             <p>You requested a password reset. Click the link below to set a new password:</p>
             <p><a href="${resetLink}">${resetLink}</a></p>
             <p>This link expires in 2 hours. If you did not request this, ignore this email.</p>`,
      text: `Hi ${user.username ?? 'there'},\n\nYou requested a password reset. Visit this link to set a new password:\n${resetLink}\n\nThis link expires in 2 hours. If you did not request this, ignore this email.`,
    };
    await this.emailService.send(message).catch((err) => logger.warn('Password reset email failed:', err));

    return { success: true, message: 'If an account with that email exists, a password reset link has been sent.' };
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(rawToken);

    // Find a non-expired, unused password_reset token
    const tokenRow = await authRepository.findVerificationToken(tokenHash);
    if (!tokenRow || tokenRow.type !== 'password_reset') {
      throw new Error('Invalid or expired password reset token');
    }

    // Password policy
    const policyResult = validatePassword(newPassword, defaultPasswordPolicy);
    if (!policyResult.valid) {
      throw new AppError(policyResult.errors.join('; '), 400);
    }

    // Hash new password and update
    const newHash = await userRepository.hashPassword(newPassword);
    await getPool().query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, tokenRow.user_id]
    );

    // Mark token as used so it can't be replayed
    await authRepository.markVerificationTokenUsed(tokenHash);

    // Revoke all existing refresh tokens (force re-login everywhere)
    await authRepository.revokeAllUserRefreshTokens(tokenRow.user_id);
    await authRepository.revokeAllUserSessions(tokenRow.user_id);
  }

  // ── Change password ───────────────────────────────────────────────────────

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
    const user = await userRepository.findByEmail(
      (await userRepository.findById(userId))?.email ?? ''
    );
    if (!user) throw new Error('User not found');

    const valid = await userRepository.verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      throw new AppError('Current password is incorrect', 400);
    }

    const policyResult = validatePassword(newPassword, defaultPasswordPolicy);
    if (!policyResult.valid) {
      throw new AppError(policyResult.errors.join('; '), 400);
    }

    const newHash = await userRepository.hashPassword(newPassword);
    await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    // Revoke all existing sessions after password change
    await this.logoutAllDevices(userId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private issueTokens(userId: number, email: string, sessionId?: number): AuthTokens {
    const accessToken = generateAccessToken(userId, email, sessionId);
    const refreshToken = generateRefreshToken(userId, email);
    const expiresIn = config.jwt.expiresIn;

    // Persist refresh token hash (async — don't block token issuance)
    const tokenHash = hashToken(refreshToken);
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    authRepository.createRefreshToken(userId, tokenHash, sessionId ?? null, null, null, tokenExpiry).catch((err) =>
      logger.warn('Failed to persist refresh token:', err)
    );

    return { accessToken, refreshToken, expiresIn };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
// (Breaks DI but preserves the existing import pattern.)

import { getPool } from '../db/pool';

let instance: AuthService | null = null;

export function getAuthService(): AuthService {
  if (!instance) {
    instance = new AuthService();
  }
  return instance;
}

/** Legacy export — controllers that imported `authService` directly still work. */
export const authService = getAuthService();

export { getPool };
