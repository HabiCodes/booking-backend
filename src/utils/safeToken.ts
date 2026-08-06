/**
 * URL-safe token generation.
 * Uses crypto.randomBytes for cryptographic strength.
 */

import { randomBytes, createHash } from 'crypto';

export function generateSecureToken(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}