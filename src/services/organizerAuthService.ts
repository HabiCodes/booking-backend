/**
 * Organizer auth service — login, token issue/refresh, password management.
 *
 * Uses a separate JWT secret (organizerSecret) so organizer tokens are
 * cryptographically distinct from admin and user tokens.
 *
 * Mirrors the user-side AuthService pattern:
 *   - Persistent refresh tokens (SHA-256 hashed) in organizer_refresh_tokens
 *   - Device sessions in organizer_sessions
 *   - Token rotation via atomic find-and-consume
 *   - Reuse detection triggers full revocation of all tokens + sessions
 *   - Per-device and global logout
 *   - Session listing and individual revocation
 */

import jwt, { type SignOptions, type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { organizerAppRepository } from '../repositories/organizerAppRepository';
import { organizerRefreshTokenRepository } from '../repositories/organizerRefreshTokenRepository';
import { hashToken } from '../utils/safeToken';
import { logger } from '../utils/logger';
import { computePermissions } from '../rbac/permissions';
import { clearOrganizerRevocationRedis, revokeOrganizerSessionsRedis } from '../middleware/organizerAuth';
import type {
  OrganizerUserRow,
  OrganizerUserPublic,
  OrganizerAppStatus,
  OrganizerSessionRow,
} from '../types';

export interface OrganizerLoginInput {
  email: string;
  password: string;
}

export interface OrganizerTokenPayload {
  id: number;
  organizationId: number;
  email: string;
  name: string;
  role: 'owner' | 'manager';
  permissions: Record<string, boolean>;
}

export interface OrganizerAuthResult {
  user: OrganizerUserPublic;
  accessToken: string;
  refreshToken: string;
}

export class OrganizerAuthService {
  // ── Login ──────────────────────────────────────────────────────────────────

  async login(input: OrganizerLoginInput): Promise<OrganizerAuthResult> {
    const user = await organizerUserRepository.findByEmail(input.email);

    if (!user || !user.is_active) {
      throw new AppError('Invalid email or password', 401);
    }

    // Account lockout check (P0 — prevent brute-force on organizer accounts)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new AppError('Account temporarily locked. Try again later.', 423);
    }

    const passwordValid = await organizerUserRepository.verifyPassword(user, input.password);
    if (!passwordValid) {
      // Increment failed_login_attempts; lock after 5 failures
      const failed = await organizerUserRepository.recordFailedLogin(user.id);
      if (failed.shouldLock) {
        throw new AppError('Account temporarily locked. Try again later.', 423);
      }
      throw new AppError('Invalid email or password', 401);
    }

    // Reset failed_login_attempts on successful login
    await organizerUserRepository.resetFailedLogin(user.id);

    // Clear any prior Redis revocation flag (re-login after logout/deactivation)
    await clearOrganizerRevocationRedis(Number(user.id));

    const result = await this.issueTokens(user);
    await organizerUserRepository.updateLastLogin(user.id);

    logger.info('Organizer login', { userId: user.id, email: user.email });
    return result;
  }

  // ── Token Issuance ─────────────────────────────────────────────────────────

  async issueTokens(user: OrganizerUserRow): Promise<OrganizerAuthResult> {
    // Merge role defaults with any user-specific permission overrides from DB
    const effectivePermissions = computePermissions(user.role, (user.permissions as Record<string, boolean>) || {});

    const payload: Record<string, unknown> = {
      id: Number(user.id),
      sub: user.email,
      organization_id: Number(user.organization_id),
      name: user.name,
      role: user.role,
      permissions: effectivePermissions,
      typ: 'organizer_access',
    };

    const accessToken = jwt.sign(payload, config.jwt.organizerSecret, {
      expiresIn: config.jwt.organizerExpiresIn as SignOptions['expiresIn'],
    });

    const refreshToken = jwt.sign(
      { sub: user.id, typ: 'organizer_refresh' },
      config.jwt.organizerSecret,
      { expiresIn: '30d' as SignOptions['expiresIn'] }
    );

    // Create a device session for this login
    const sessionId = await organizerRefreshTokenRepository.createSession(
      Number(user.id),
      null,
      null,
      null,
      true
    );

    // Persist refresh token hash — MUST succeed before returning tokens to avoid
    // a false reuse-detection cascade if the DB write fails silently
    const tokenHash = hashToken(refreshToken);
    const tokenExpiry = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
    await organizerRefreshTokenRepository.createRefreshToken(
      Number(user.id), tokenHash, sessionId, null, null, tokenExpiry
    );

    const { password_hash: _pw, ...safeUser } = user as unknown as Record<string, unknown>;
    return {
      user: safeUser as unknown as OrganizerUserPublic,
      accessToken,
      refreshToken,
    };
  }

  // ── Token Refresh (Rotation) ───────────────────────────────────────────────

  async refreshTokens(rawRefreshToken: string): Promise<OrganizerAuthResult | null> {
    const tokenHash = hashToken(rawRefreshToken);

    // Verify JWT payload first (cheap crypto check, no DB round-trip)
    const payload = this.verifyRefreshToken(rawRefreshToken);
    if (!payload) {
      throw new AppError('Invalid refresh token payload', 401);
    }

    // Atomic find-and-consume: single UPDATE ... RETURNING query
    const consumed = await organizerRefreshTokenRepository.findAndConsumeRefreshToken(tokenHash);

    if (!consumed) {
      // Reuse detected — revoke ALL tokens + sessions for this organizer
      const userId = payload.sub;
      await organizerRefreshTokenRepository.revokeAllUserRefreshTokens(userId);
      await organizerRefreshTokenRepository.revokeAllUserSessions(userId);
      logger.warn('Organizer refresh token reuse detected', { userId });
      throw new AppError('Refresh token reuse detected — all sessions have been revoked for security', 401);
    }

    // Verify organizer still exists and is active
    const user = await organizerUserRepository.findById(payload.sub);
    if (!user || !user.is_active) {
      throw new AppError('Account no longer active', 403);
    }

    // Issue new tokens, binding to the same session
    return this.issueTokens(user);
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async logoutCurrentDevice(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    // Look up session_id so we can revoke the specific JWT
    const existing = await organizerRefreshTokenRepository.findRefreshTokenByHash(tokenHash);
    if (existing?.session_id) {
      await organizerRefreshTokenRepository.revokeSession(existing.session_id);
      await organizerRefreshTokenRepository.revokeRefreshTokensBySessionId(existing.session_id);
      // Also set user-wide flag as defense-in-depth
      await revokeOrganizerSessionsRedis(existing.organizer_user_id);
    }
    await organizerRefreshTokenRepository.revokeRefreshToken(tokenHash);
  }

  async logoutAllDevices(userId: number): Promise<{ revokedTokens: number; revokedSessions: number }> {
    const revokedTokens = await organizerRefreshTokenRepository.revokeAllUserRefreshTokens(userId);
    const revokedSessions = await organizerRefreshTokenRepository.revokeAllUserSessions(userId);
    // Set Redis revocation flag so existing JWTs become invalid immediately
    await revokeOrganizerSessionsRedis(userId);
    return { revokedTokens, revokedSessions };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async getMySessions(userId: number): Promise<OrganizerSessionRow[]> {
    return organizerRefreshTokenRepository.getUserSessions(userId);
  }

  async revokeSession(sessionId: number): Promise<void> {
    await organizerRefreshTokenRepository.revokeSession(sessionId);
    await organizerRefreshTokenRepository.revokeRefreshTokensBySessionId(sessionId);
  }

  // ── JWT Verification ──────────────────────────────────────────────────────

  verifyAccessToken(token: string): OrganizerTokenPayload | null {
    try {
      const decoded = jwt.verify(token, config.jwt.organizerSecret, { algorithms: ['HS256'] }) as JwtPayload;
      if (decoded.typ !== undefined && decoded.typ !== 'organizer_access') return null;
      if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string') return null;
      return {
        id: decoded.id,
        organizationId: Number(decoded.organization_id),
        email: decoded.sub,
        name: typeof decoded.name === 'string' ? decoded.name : '',
        role: (decoded.role === 'owner' || decoded.role === 'manager') ? decoded.role : 'manager',
        permissions: typeof decoded.permissions === 'object' && !Array.isArray(decoded.permissions)
          ? decoded.permissions as Record<string, boolean> : {},
      };
    } catch {
      return null;
    }
  }

  verifyRefreshToken(token: string): { sub: number; typ: string } | null {
    try {
      const decoded = jwt.verify(token, config.jwt.organizerSecret, { algorithms: ['HS256'] }) as JwtPayload;
      if (decoded.typ !== undefined && decoded.typ !== 'organizer_refresh') return null;
      if (typeof decoded.sub !== 'number') return null;
      return { sub: decoded.sub, typ: decoded.typ || 'organizer_refresh' };
    } catch {
      return null;
    }
  }

  // ── Application / Ownership ───────────────────────────────────────────────

  async validateUserOwnership(userId: number, organizationId: number): Promise<boolean> {
    const user = await organizerUserRepository.findById(userId);
    if (!user) return false;
    return user.organization_id === organizationId && user.is_active;
  }

  async checkApplicationStatus(organizationId: number): Promise<OrganizerAppStatus | null> {
    const app = await organizerAppRepository.findByOrganizationId(organizationId);
    return app ? app.status : null;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
const organizerAuthService = new OrganizerAuthService();
export { organizerAuthService };
