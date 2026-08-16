/**
 * Organizer auth service — login, token issue/refresh, password management.
 *
 * Uses a separate JWT secret (organizerSecret) so organizer tokens are
 * cryptographically distinct from admin and user tokens.
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { organizerUserRepository } from '../repositories/organizerUserRepository';
import { organizerAppRepository } from '../repositories/organizerAppRepository';
import { hashPassword, comparePassword } from '../utils/crypto';
import { logger } from '../utils/logger';
import type {
  OrganizerUserRow,
  OrganizerUserPublic,
  OrganizerAppStatus,
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
  async login(input: OrganizerLoginInput): Promise<OrganizerAuthResult> {
    const user = await organizerUserRepository.findByEmail(input.email);

    if (!user || !user.is_active) {
      throw new AppError('Invalid email or password', 401);
    }

    const passwordValid = await organizerUserRepository.verifyPassword(user, input.password);
    if (!passwordValid) {
      throw new AppError('Invalid email or password', 401);
    }

    const result = await this.issueTokens(user);
    await organizerUserRepository.updateLastLogin(user.id);

    logger.info('Organizer login', { userId: user.id, email: user.email });
    return result;
  }

  async issueTokens(user: OrganizerUserRow): Promise<OrganizerAuthResult> {
    const payload: Record<string, unknown> = {
      id: user.id,
      sub: user.email,
      organization_id: Number(user.organization_id),
      name: user.name,
      role: user.role,
      permissions: (user.permissions as Record<string, boolean>) || {},
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

    const { password_hash: _pw, ...safeUser } = user as unknown as Record<string, unknown>;
    return {
      user: safeUser as unknown as OrganizerUserPublic,
      accessToken,
      refreshToken,
    };
  }

  verifyAccessToken(token: string): OrganizerTokenPayload | null {
    try {
      return jwt.verify(token, config.jwt.organizerSecret) as OrganizerTokenPayload;
    } catch {
      return null;
    }
  }

  verifyRefreshToken(token: string): { sub: number; typ: string } | null {
    try {
      return jwt.verify(token, config.jwt.organizerSecret) as unknown as { sub: number; typ: string };
    } catch {
      return null;
    }
  }

  async refreshUserTokens(userId: number): Promise<OrganizerAuthResult | null> {
    const user = await organizerUserRepository.findById(userId);
    if (!user || !user.is_active) return null;
    return this.issueTokens(user);
  }

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
