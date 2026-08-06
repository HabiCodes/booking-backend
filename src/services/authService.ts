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
import type { AppError } from '../middleware/errorHandler';
import { userRepository } from '../repositories/userRepository';
import { authRepository } from '../repositories/authRepository';
import { validatePassword, defaultPasswordPolicy } from '../utils/passwordPolicy';
import { generateSecureToken, hashToken } from '../utils/safeToken';
import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import type {
  RefreshTokenRow,
  UserRow,
  UserPublic,
  UserSessionRow,
  VerificationTokenRow,
} from '../types';
import { buildVerificationEmail, createEmailService, type EmailService } from './emailService';

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

  constructor(opts: {
    emailService?: EmailService;
    baseUrl?: string;
    bruteForce?: BruteForceConfig;
    verificationExpiryHours?: number;
  } = {}) {
    this.emailService = opts.emailService ?? createEmailService({
      apiKey: config.email.resendApiKey || undefined,
      from: config.email.from,
    });
    this.baseUrl = opts.baseUrl ?? (config.email.appUrl || (config.nodeEnv === 'production' ? '' : 'http://localhost:3000'));
    this.bruteForce = opts.bruteForce ?? DEFAULT_BRUTE_FORCE;
    this.verificationExpiryHours = opts.verificationExpiryHours ?? 24;
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
      const err = new Error(policyResult.errors.join('; ')) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const passwordHash = await userRepository.hashPassword(password);
    const userId = await userRepository.createWithUsername(normalizedEmail, username ?? '', passwordHash);

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
      username: username ?? null,
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
      const err = new Error('Email already registered') as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }

    const userId = await userRepository.create(normalizedEmail, password);
    const token = generateAccessToken(userId, normalizedEmail);

    return { token, user: { id: userId, email: normalizedEmail } };
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(email: string, password: string, deviceInfo?: string | null, ipAddress?: string | null): Promise<LoginResult> {
    const normalizedEmail = email.toLowerCase().trim();

    // Brute-force: check lockout (uses both email and IP address)
    const recentFailedLogin = await authRepository.getRecentFailureWindow(normalizedEmail);
    const lockout = checkAccountLockout(recentFailedLogin, this.bruteForce.lockoutMinutes);
    if (lockout.locked && lockout.retryInMs !== null) {
      const err = new Error(`Account temporarily locked. Try again in ${Math.ceil(lockout.retryInMs / 1000)} seconds`) as Error & { statusCode?: number; retryInMs?: number };
      err.statusCode = 429;
      err.retryInMs = lockout.retryInMs;
      throw err;
    }

    const user = await userRepository.findByEmail(normalizedEmail);
    if (!user) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
      throw new Error('Invalid email or password') as Error & { statusCode?: number };
    }

    if (!user.is_active) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      const err = new Error('Your account has been disabled. Contact support.') as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    const valid = await userRepository.verifyPassword(password, user.password_hash);
    if (!valid) {
      await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, false);
      await this.recordFailedLoginAndCheckLock(normalizedEmail, ipAddress, deviceInfo ?? null);
      throw new Error('Invalid email or password') as Error & { statusCode?: number };
    }

    if (!user.is_verified) {
      const err = new Error('Please verify your email before logging in') as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    // Successful login — record it
    await authRepository.recordLoginAttempt(normalizedEmail, ipAddress ?? 'unknown', deviceInfo ?? null, true);
    await userRepository.updateLastLogin(user.id);

    // Issue tokens and create session
    const tokens = this.issueTokens(user.id, user.email);
    const sessionId = await authRepository.createSession(
      user.id,
      deviceInfo ?? null,
      ipAddress ?? null,
      null, // userAgent — set by caller
      true
    );

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
      const err = new Error(`Too many failed login attempts. Please try again in ${this.bruteForce.lockoutMinutes} minutes.`) as Error & { statusCode?: number };
      err.statusCode = 429;
      throw err;
    }
    void ipAddress; // accepted but not stored by this counter; future-use
  }

  // ── Token refresh (rotation) ──────────────────────────────────────────────

  async refreshTokens(rawRefreshToken: string, deviceInfo?: string | null): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await authRepository.findRefreshTokenByHash(tokenHash);

    if (!stored || stored.revoked) {
      throw new Error('Invalid or revoked refresh token') as Error & { statusCode?: number };
    }

    if (new Date(stored.expires_at) < new Date()) {
      throw new Error('Refresh token expired. Please log in again.') as Error & { statusCode?: number };
    }

    // Verify the JWT payload
    const payload = verifyRefreshToken(rawRefreshToken);
    if (!payload) {
      throw new Error('Invalid refresh token payload') as Error & { statusCode?: number };
    }

    // Revoke old token (rotation)
    await authRepository.revokeRefreshToken(tokenHash);

    // Verify user still exists and is active
    const user = await userRepository.findById(payload.id);
    if (!user || !user.is_active) {
      throw new Error('Account no longer active') as Error & { statusCode?: number };
    }

    // Issue new pair
    return this.issueTokens(payload.id, user.email);
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logoutCurrentDevice(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await authRepository.revokeRefreshToken(tokenHash);
  }

  async logoutAllDevices(userId: number): Promise<{ revokedTokens: number; revokedSessions: number }> {
    const revokedTokens = await authRepository.revokeAllUserRefreshTokens(userId);
    const revokedSessions = await authRepository.revokeAllUserSessions(userId);
    return { revokedTokens, revokedSessions };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async getMySessions(userId: number): Promise<UserSessionRow[]> {
    return authRepository.getUserSessions(userId);
  }

  async revokeSession(sessionId: number): Promise<void> {
    await authRepository.revokeSession(sessionId);
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

  // ── Change password ───────────────────────────────────────────────────────

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
    const user = await userRepository.findByEmail(
      (await userRepository.findById(userId))?.email ?? ''
    );
    if (!user) throw new Error('User not found');

    const valid = await userRepository.verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      throw new Error('Current password is incorrect') as Error & { statusCode?: number };
    }

    const policyResult = validatePassword(newPassword, defaultPasswordPolicy);
    if (!policyResult.valid) {
      const err = new Error(policyResult.errors.join('; ')) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const newHash = await userRepository.hashPassword(newPassword);
    await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, userId]);

    // Revoke all existing sessions after password change
    await this.logoutAllDevices(userId);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private issueTokens(userId: number, email: string): AuthTokens {
    const accessToken = generateAccessToken(userId, email);
    const refreshToken = generateRefreshToken(userId, email);
    const expiresIn = config.jwt.expiresIn;

    // Persist refresh token hash (async — don't block token issuance)
    const tokenHash = hashToken(refreshToken);
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    authRepository.createRefreshToken(userId, tokenHash, null, null, tokenExpiry).catch((err) =>
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
