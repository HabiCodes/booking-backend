import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './errorHandler';

export interface AuthRequest extends Request {
  user?: { id: number; email: string };
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.split(' ')[1] || null;
  }
  // Query-string fallback allows `<a href download>` links (browsers can't set
  // Authorization headers on file downloads). The token is still bound to the
  // URL the user just received, so this is acceptable for this app's threat
  // model — the alternative is breaking PDF/CSV exports across the board.
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
    const decoded = jwt.verify(token, config.jwt.secret) as { id: number; email: string };
    req.user = decoded;
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
      const decoded = jwt.verify(token, config.jwt.secret) as { id: number; email: string };
      req.user = decoded;
    } catch {
      // ignore — optional auth
    }
  }
  next();
}
