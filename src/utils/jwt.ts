import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config';

export function generateUserToken(userId: number, email: string): string {
  const opts: SignOptions = { expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ id: userId, email }, config.jwt.secret, opts);
}

export function generateAdminToken(adminId: number, email: string): string {
  const opts: SignOptions = { expiresIn: config.jwt.adminExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ id: adminId, email }, config.jwt.adminSecret, opts);
}
