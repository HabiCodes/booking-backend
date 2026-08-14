/**
 * Enhanced JWT utilities — access tokens + refresh tokens.
 *
 * Access tokens carry an optional session_id claim.  When present, the auth
 * middleware validates the session in user_sessions (revoked = false) on each
 * request.  Tokens without session_id are accepted for backward compatibility
 * during the rollout window (they simply skip the session check).
 */

import jwt, { type SignOptions, type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';

const ACCESS_EXPIRY = config.jwt.expiresIn;        // e.g. '15m'
const REFRESH_EXPIRY_DAYS = 30;                     // 30 days

export interface AccessTokenPayload {
  id: number;
  email: string;
  session_id?: number;
}

function buildPayload(userId: number, email: string): { id: number; sub: string } {
  return { id: userId, sub: email };
}

/**
 * Verify that the JWT payload has the expected token type.
 * Accepts backward-compatible tokens that lack a typ claim.
 */
function verifyTokenType(decoded: JwtPayload | string | undefined, expectedType: string): boolean {
  if (typeof decoded !== 'object' || decoded === null) return false;
  if (decoded.typ !== undefined && decoded.typ !== expectedType) return false;
  return true;
}

export function generateAccessToken(userId: number, email: string, sessionId?: number): string {
  const payload: Record<string, unknown> = { ...buildPayload(userId, email), typ: 'access' };
  if (typeof sessionId === 'number') {
    payload.session_id = sessionId;
  }
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: ACCESS_EXPIRY as SignOptions['expiresIn'],
  });
}

export function generateRefreshToken(userId: number, email: string): string {
  const expiresIn = `${REFRESH_EXPIRY_DAYS}d`;
  return jwt.sign({ ...buildPayload(userId, email), typ: 'refresh' }, config.jwt.secret, {
    expiresIn: expiresIn as SignOptions['expiresIn'],
  });
}

export function generateAdminAccessToken(
  adminId: number,
  email: string,
  role?: string,
  permissions?: Record<string, boolean>,
  permissionsUpdatedAt?: string | null
): string {
  const payload: Record<string, unknown> = { id: adminId, sub: email, typ: 'admin_access', role, permissions };
  if (permissionsUpdatedAt) {
    payload.permissions_updated_at = permissionsUpdatedAt;
  }
  return jwt.sign(
    payload,
    config.jwt.adminSecret,
    {
      expiresIn: (config.jwt.adminExpiresIn ?? '12h') as SignOptions['expiresIn'],
    }
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    if (!verifyTokenType(decoded, 'access')) return null;
    if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string') return null;
    const sessionId = typeof decoded.session_id === 'number' ? decoded.session_id : undefined;
    return { id: decoded.id, email: decoded.sub, session_id: sessionId };
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { id: number; email: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    if (!verifyTokenType(decoded, 'refresh')) return null;
    if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string') return null;
    return { id: decoded.id, email: decoded.sub };
  } catch {
    return null;
  }
}

/**
 * Verify an admin access token, checking type claim and required fields.
 */
export function verifyAdminAccessToken(token: string): { id: number; email: string; role?: string; permissions?: Record<string, boolean>; permissionsUpdatedAt?: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwt.adminSecret) as JwtPayload;
    if (!verifyTokenType(decoded, 'admin_access')) return null;
    if (typeof decoded.id !== 'number' || typeof decoded.sub !== 'string') return null;
    const role = typeof decoded.role === 'string' ? decoded.role : undefined;
    const permissions = typeof decoded.permissions === 'object' && !Array.isArray(decoded.permissions)
      ? decoded.permissions as Record<string, boolean>
      : undefined;
    const permissionsUpdatedAt = typeof decoded.permissions_updated_at === 'string' ? decoded.permissions_updated_at : undefined;
    return { id: decoded.id, email: decoded.sub, role, permissions, permissionsUpdatedAt };
  } catch {
    return null;
  }
}

/**
 * Verify an organizer access token, checking type claim and required fields.
 */
export function verifyOrganizerAccessToken(token: string): { id: number; organizationId: number; email: string; name: string; role: 'owner' | 'manager'; permissions: Record<string, boolean> } | null {
  try {
    const decoded = jwt.verify(token, config.jwt.organizerSecret) as JwtPayload;
    if (!verifyTokenType(decoded, 'organizer_access')) return null;
    if (typeof decoded.id !== 'number') return null;
    if (typeof decoded.sub !== 'string') return null;
    if (typeof decoded.organization_id !== 'number') return null;
    if (typeof decoded.name !== 'string') return null;
    if (decoded.role !== 'owner' && decoded.role !== 'manager') return null;
    const permissions = typeof decoded.permissions === 'object' && !Array.isArray(decoded.permissions)
      ? decoded.permissions as Record<string, boolean>
      : {};
    return {
      id: decoded.id,
      organizationId: decoded.organization_id,
      email: decoded.sub,
      name: decoded.name,
      role: decoded.role,
      permissions,
    };
  } catch {
    return null;
  }
}
