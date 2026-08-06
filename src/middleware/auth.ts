import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';
import { verifyAccessToken, verifyRefreshToken } from '../utils/jwt';

export interface AuthRequest extends Request {
  user?: { id: number; email: string };
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.split(' ')[1] || null;
  }
  const queryToken = (req.query.token as string | undefined)?.trim();
  return queryToken || null;
}

export function authMiddleware(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);
  if (!token) {
    throw new AppError('Unauthorized', 401);
  }

  try {
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      throw new AppError('Invalid or expired token', 401);
    }
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch {
    throw new AppError('Invalid or expired token', 401);
  }
}

export function optionalAuth(
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const token = header.split(' ')[1];
      const decoded = verifyAccessToken(token);
      if (decoded) {
        req.user = { id: decoded.id, email: decoded.email };
      }
    } catch {
      // ignore — optional auth
    }
  }
  next();
}
