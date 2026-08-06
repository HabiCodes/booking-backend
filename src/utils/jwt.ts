/**
 * Enhanced JWT utilities — access tokens + refresh tokens.
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config';

const ACCESS_EXPIRY = config.jwt.expiresIn;        // e.g. '7d'
const REFRESH_EXPIRY_DAYS = 30;                     // 30 days

function buildPayload(userId: number, email: string): { id: number; email: string } {
  return { id: userId, email };
}

export function generateAccessToken(userId: number, email: string): string {
  return jwt.sign(buildPayload(userId, email), config.jwt.secret, {
    expiresIn: ACCESS_EXPIRY as SignOptions['expiresIn'],
  });
}

export function generateRefreshToken(userId: number, email: string): string {
  const expiresIn = `${REFRESH_EXPIRY_DAYS}d`;
  return jwt.sign(buildPayload(userId, email), config.jwt.secret, {
    expiresIn: expiresIn as SignOptions['expiresIn'],
  });
}

export function generateAdminAccessToken(
  adminId: number,
  email: string,
  role?: string,
  permissions?: Record<string, boolean>
): string {
  return jwt.sign(
    { id: adminId, email, role, permissions },
    config.jwt.adminSecret,
    {
      expiresIn: (config.jwt.adminExpiresIn ?? '12h') as SignOptions['expiresIn'],
    }
  );
}

export function verifyAccessToken(token: string): { id: number; email: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as { id: number; email: string };
    if (typeof decoded.id !== 'number' || typeof decoded.email !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { id: number; email: string } | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as { id: number; email: string };
    if (typeof decoded.id !== 'number' || typeof decoded.email !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}
